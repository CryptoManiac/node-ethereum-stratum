'use strict';

const port = 3333;

const maxStratumDiff = 10000;
const minStratumDiff = 0.0001;
const defaultStratumDiff = 1.0;
const nonceSize = 2;

const net = require('net');
const cluster = require('cluster');
const Ethashcpp = require('node-ethash');
const LevelUp = require('levelup');
const MemDown = require('memdown');
const deasync = require('deasync');
const numCPUs = require('os').cpus().length;

let states = { generating : false };

const makeNonce = require('./util').makeNonce;
const generateUnid = require('./util').generateUnid;

let vitalikDiff1 = 2n ** 256n;
let stratumDiff1 = vitalikDiff1 / (2n ** 32n);

let getEpoc = new Ethashcpp().getEpoc;

function diffToTarget(diff) {
    let d = diff.toFixed(4);

    if (d > 1) {
        return stratumDiff1 * BigInt(Math.pow(d, -1).toFixed(0));
    } else {
        return stratumDiff1 * 10000n / BigInt(d * 10000);
    }

    return stratumDiff1;
}

function updateStates(blkNum) {
    if (states.generating) return;

    let currEpoch = getEpoc(blkNum);
    let nextEpoch = currEpoch + 1;

    if (!states[currEpoch]) {
        console.log('Calculating state for current epoch #' + currEpoch);
        states.generating = true;
        let ethash = new Ethashcpp(LevelUp(MemDown()));
        ethash.loadEpoc(currEpoch * 30000, st => {
            if (!st) return;
            states = states || {}
            states[currEpoch] = ethash;
        });
        deasync.loopWhile(() => { return !states[currEpoch]; });
        states.generating = false;
        console.log('Calculation done, current seed is ' + states[currEpoch].seed.toString('hex'));
    }

    if (!states[nextEpoch]) {
        console.log('Pre-calculating next state for epoch #' + nextEpoch);
        let ethash = new Ethashcpp(LevelUp(MemDown()));
        ethash.loadEpoc(nextEpoch * 30000, st => {
            if (!st || states[nextEpoch]) return;
            states = states || {}
            states[nextEpoch] = ethash;
            console.log('Pre-calculation done, next seed is ' + states[nextEpoch].seed.toString('hex'));
        });
    }
}

function getHash(blkNum, hash, nonce) {
    let epoch = getEpoc(blkNum);

    // That is unlikely to happen, but we need to 
    //  wait in case if there is no cache calculated for the job's epoch
    deasync.loopWhile(() => { return !states[epoch]; });

    let ethash = states[epoch];
    let r = ethash.doHash(Buffer(hash, 'hex'), Buffer(nonce, 'hex'));
    r.mix_hash = r.mix_hash.toString('hex');
    r.result = r.result.toString('hex');

    return r;
}

function handleMinerData(method, params, socket, sendReply, pushMessage, processAuth, sendJob, processJob) {
    if (!method || !params) {
        sendReply('Malformed stratum request');
    }

    switch(method) {
        case 'mining.subscribe':
            if (params[1] != 'EthereumStratum/1.0.0') {
                return sendReply('Unsupported protocol version');
            }

            let subscriptionHash = generateUnid();
            let extraNonce = socket.extraNonce;

            sendReply(null, [
                [
                    "mining.notify", 
                    subscriptionHash,
                    "EthereumStratum/1.0.0"
                ],
                extraNonce
            ]);
        break;

        case 'mining.authorize':
            processAuth(params);
        break;

        case 'mining.submit':
            processJob(params);
        break;

        default:
            sendReply('Unknown stratum method');
    }
}

function StratumServer(port, nonceSize, defaultDiff, minDiff, maxDiff) {
    let emptyMiner = function() {
        return {
            clientDiff : Number.POSITIVE_INFINITY,
            clientTarget : '0',
            clientTargetN : 0n,
            active : false,
            userName : '',
            workerName : '',
            lastActivity : 0
        };
    };

    let makeJob = function(extraNonce) {
        let topJob = server.jobData[server.jobData.length - 1];
        if (topJob === null) {
            return false;
        }

        return JSON.stringify({
            "id": null,
            "method": "mining.notify",
            "params": [
                extraNonce + topJob.jobId,
                topJob.seedHash,
                topJob.powHash,
                true
            ]
        }) + "\n";
    };

    let findJob = function(jobId) {
        let index = server.jobData.findIndex(job => job.jobId == jobId);
        if (index != -1) {
            return server.jobData[index];
        }
        return false;
    }

    let broadcastJob = function() {
        let conns = Object.values(server.conns);
        for (let i = 0; i < conns.length; ++i) {
            let socket = conns[i];
            // Don't send jobs to non-subscribed clients
            if (!server.miners[socket.extraNonce].active) return;
            let job = makeJob(socket.extraNonce);
            if (!socket.writable || !job) return;
            socket.write(job);
        }
    };

    let handleMessage = function (socket, jsonData, pushMessage) {
        if (!jsonData.id) {
            console.warn('Malformed stratum request from ' + socket.remoteAddress);
            return;
        }

        let sendReply = function (error, result) {
            if (!socket.writable) {
                return;
            }
            let sendData = JSON.stringify({
                id: jsonData.id,
                error: error ? { code: -1, message: error } : null,
                result: !error ? result : null
            }) + "\n";
            socket.write(sendData);
        };

        let sendJob = function() {
            let job = makeJob(socket.extraNonce);
            if (!socket.writable || !job) {
                return;
            }
            socket.write(job);
        };

        let processAuth = function(params) {
            let miner = server.miners[socket.extraNonce];

            let [login, password] = params;
            let diff = parseFloat(password);
            if (isNaN(diff) || diff < minDiff || diff > maxDiff) {
                diff = defaultDiff;
            }

            [miner.userName, miner.workerName] = login.split('.');
            [miner.clientDiff, miner.clientTargetN, miner.active] = [diff, diffToTarget(miner.clientDiff), true];
            miner.clientTarget = "0x" + miner.clientTargetN.toString(16);

            process.send({
                sender : 'worker',
                senderId : process.pid,
                kind : 'updateminer',
                extraNonce : socket.extraNonce,
                info : { active : true, clientDiff : diff, userName : miner.userName, workerName : miner.workerName }
            });

            sendReply(null, true);
            pushMessage('mining.set_difficulty', [diff]);
            sendJob();

            console.log('Miner authorized: ' + login + '/diff=' + diff);
        };

        let processJob = function(params) {
            // Job ID field must contain extranonce and upstream's job id
            if (params[1].length != server.nonceSize * 2 + 16) {
                return sendReply('Invalid job id', null);
            }

            let jobId = params[1].substr(server.nonceSize * 2);
            let extraNonce = params[1].substr(0, server.nonceSize * 2);

            let job = findJob(jobId);
            if (!job) return sendReply('Job not found', null);

            let miner = server.miners[extraNonce];
            if (!miner) return sendReply('Unknown job author', null);

            let r = getHash(job.blockHeight, job.powHash, extraNonce + params[2]);
            let hashN = BigInt('0x' + r.result);

            if (hashN > miner.clientTargetN) return sendReply('High hash', null);

            // Update activity
            [miner.active, miner.lastActivity] = [true, new Date()];
            process.send({
                sender : 'worker',
                senderId : process.pid,
                kind : 'updateminer',
                extraNonce : extraNonce,
                info : { active : miner.active, lastActivity : miner.lastActivity }
            });

            // Send work data to master process
            process.send({
                sender : 'worker',
                senderId : process.pid,
                kind : job.blockTargetN > hashN ? 'candidate' : 'share',
                jobId : jobId,
                creatorId : miner.userName,
                creatorUnit : miner.workerName,
                creatorIp : socket.remoteAddress,
                height : job.blockHeight,
                blockTarget : job.blockTarget,
                shareTarget : miner.clientTarget,
                nonce : "0x" + extraNonce + params[2],
                mixHash : "0x" + r.mix_hash,
                powHash : "0x" + job.powHash,
                result : "0x" + r.result
            });

            sendReply(null, true);
        };

        handleMinerData(jsonData.method, jsonData.params, socket, sendReply, pushMessage, processAuth, sendJob, processJob);
    };

    function socketConn(socket) {
        let extraNonce = makeNonce(this);
        let minerId = socket.remoteAddress + ':' + socket.remotePort;

        socket.setKeepAlive(true);
        socket.setEncoding('utf8');
        socket.extraNonce = extraNonce;

        this.miners[extraNonce] = emptyMiner();
        this.conns[minerId] = socket;

        process.send({ sender: 'worker', kind: 'newminer', extraNonce: extraNonce });

        let dataBuffer = '';

        let pushMessage = function (method, params) {
            if (!socket.writable) {
                return;
            }
            let sendData = JSON.stringify({
                id: null,
                method: method,
                params: params
            }) + "\n";
            socket.write(sendData);
        };

        socket.on('data', function (d) {
            dataBuffer += d;
            if (Buffer.byteLength(dataBuffer, 'utf8') > 10240) { //10KB
                dataBuffer = null;
                console.warn('Excessive packet size from: ' + socket.remoteAddress);
                socket.destroy();
                return;
            }
            if (dataBuffer.indexOf('\n') !== -1) {
                let messages = dataBuffer.split('\n');
                let incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                for (let i = 0; i < messages.length; i++) {
                    let message = messages[i];
                    if (message.trim() === '') {
                        continue;
                    }
                    let jsonData;
                    try {
                        jsonData = JSON.parse(message);
                    }
                    catch (e) {
                        console.warn("Malformed message from " + socket.remoteAddress + " Message: " + message);
                        socket.destroy();
                        break;
                    }
                    handleMessage(socket, jsonData, pushMessage);
                }
                dataBuffer = incomplete;
            }
        }).on('error', err => {
            if (err.code !== 'ECONNRESET') {
                console.warn("Socket Error from " + socket.remoteAddress + " Error: " + err);
            }
        }).on('close', () => {
            delete this.conns[minerId];
            this.freeExtraNonce(extraNonce);
            pushMessage = () => {
            };
        });
    }

    let server = net.createServer(socketConn);

    server.conns = {};
    server.miners = {};
    server.jobData = [null];
    server.nonceSize = nonceSize;

    server.freeExtraNonce = function(extraNonce) {
        server.miners[extraNonce].active = false;
    };

    server.setJob = function(data) {
        data = data.map(job => {
            job.blockTargetN = BigInt(job.blockTarget);
            job.powHash = job.powHash.substr(2);
            job.seedHash = job.seedHash.substr(2);
            return job;
        });
        let topJob = data[data.length - 1];
        server.jobData = data;
        updateStates(topJob.blockHeight);
        broadcastJob();
    };

    server.setMiner = function(extraNonce) {
        server.miners[extraNonce] = emptyMiner();
    };

    server.updateMiner = function(extraNonce, info) {
        let keys = Object.keys(info);
        let miner = server.miners[extraNonce];

        for (let i in keys) {
            let prop = keys[i];
            miner[prop] = info[prop];
            if (prop == 'clientDiff') {
                [miner.clientDiff, miner.clientTargetN] = [info[prop], diffToTarget(info[prop])];
                miner.clientTarget = "0x" + miner.clientTargetN.toString(16);
            }
        }
    };

    server.listen(port, error => {
        if (error) {
            console.error("Unable to start server on: " + port + " Message: " + error);
            return;
        }
        console.log("Started server on port: " + port);
    });

    return server;
};

let workers = [];

if (cluster.isMaster) {
    console.log('Stratum master ' + process.pid + ' is running');

    // Fork workers.
    for (let i = 0; i < numCPUs; i++) {
        let worker = cluster.fork();
        // Forward any worker message from their master process to our application endpoint
        worker.on('message', async msg => process.send(msg));
        workers.push(worker);
    }

    process.on('message', async msg => {
        if (msg.kind == 'workdata') {
            // Display job info
            let topJob = msg.data[msg.data.length - 1];
            console.log(new Date().toString() + ': New block #' + topJob.jobId + ' to mine at height ' + topJob.blockHeight + ' from ' + topJob.endpoint);
        }

        // Forward any message received by master to worker processes
        for (let i in workers) {
            workers[i].send(msg);
        }
    });

    cluster.on('exit', (worker, code, signal) => {
        console.log('Stratum worker ' + worker.process.pid + ' died');
    });
}

if (cluster.isWorker) {
    let s = StratumServer(port, nonceSize, defaultStratumDiff, minStratumDiff, maxStratumDiff);
    process.on('message', async msg => {
        if (msg.senderId == process.pid)
            return; // from self

        if (msg.sender && msg.sender == 'upstream') {
            s.setJob(msg.data);
        }

        if (msg.sender && msg.sender == 'worker') {
            if (msg.kind == 'newminer') s.setMiner(msg.extraNonce);
            if (msg.kind == 'updateminer') s.updateMiner(msg.extraNonce, msg.info);
        }
    });
    console.log('Stratum worker ' + process.pid + ' started');
}

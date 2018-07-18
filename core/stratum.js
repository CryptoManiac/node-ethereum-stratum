'use strict';

const port = 3333;

const maxStratumDiff = 10000;
const minStratumDiff = 0.0001;
const defaultStratumDiff = 1.0;

const net = require('net');
const cluster = require('cluster');
const Ethashcpp = require('node-ethash');
const LevelUp = require('levelup');
const MemDown = require('memdown');
const deasync = require('deasync');
const numCPUs = require('os').cpus().length;

let states = { generating : false };

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
            let extraNonce = socket.minerData.extraNonce;

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

function StratumServer(port, defaultDiff, minDiff, maxDiff) {

    let prepareJob = function() {
        let topJob = server.jobData[server.jobData.length - 1];
        if (topJob === null) {
            return false;
        }

        return [
            topJob.jobId,
            topJob.seedHash,
            topJob.powHash,
            true
        ];
    };

    let findJob = function(jobId) {
        let index = server.jobData.findIndex(job => job.jobId == jobId);
        if (index != -1) {
            return server.jobData[index];
        }
        return false;
    }

    let broadcastJob = function() {
        let job = JSON.stringify({
            "id": null,
            "method": "mining.notify",
            "params": prepareJob()
        }) + "\n";

        let users = Object.values(server.activeMiners);
        for (let i = 0; i < users.length; ++i) {
            let socket = users[i];
            if (!socket.writable) return;
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
            let job = prepareJob();
            if (!socket.writable || !job) {
                return;
            }
            let sendData = JSON.stringify({
                "id": null,
                "method": "mining.notify",
                "params": job
            }) + "\n";
            socket.write(sendData);
        };

        let processAuth = function(params) {
            let [login, password] = params;
            [socket.minerData.userName, socket.minerData.workerName] = login.split('.');
            let difficulty = parseFloat(password);
            if (!isNaN(difficulty) && difficulty >= minDiff && difficulty <= maxDiff) {
                socket.minerData.clientDiff = difficulty;
            }
            console.log('Miner authorized: ' + login);
            socket.minerData.authorized = true;
            sendReply(null, true);
            pushMessage('mining.set_difficulty', [socket.minerData.clientDiff]);
            sendJob();
        };

        let processJob = function(params) {
            let job = findJob(params[1]);
            if (!job) return sendReply('Job not found', null);
            let workNonce = socket.minerData.extraNonce + params[2];
            let clientTargetN = diffToTarget(socket.minerData.clientDiff);

            let r = getHash(job.blockHeight, job.powHash, workNonce);
            let hashN = BigInt('0x' + r.result);
            let isShare = clientTargetN >= hashN;
            let isBlock = isShare && job.blockTarget >= hashN;

            if (!isShare) return sendReply('High hash', null);

            // Update activity
            socket.minerData.lastActivity = new Date();

            // Send work data to master process
            process.send({
                sender : 'worker',
                senderId : process.pid,
                kind : isBlock ? 'candidate' : 'share',
                jobId : params[1],
                creatorId : socket.minerData.userName,
                creatorUnit : socket.minerData.workerName,
                creatorIp : socket.remoteAddress,
                height : job.blockHeight,
                blockTarget : "0x" + job.blockTarget.toString(16),
                shareTarget : "0x" + clientTargetN.toString(16),
                nonce : "0x" + workNonce,
                mixHash : "0x" + r.mix_hash,
                powHash : "0x" + job.powHash,
                result : "0x" + r.result
            });

            sendReply(null, true);
        };

        handleMinerData(jsonData.method, jsonData.params, socket, sendReply, pushMessage, processAuth, sendJob, processJob);
    };

    function socketConn(socket) {
        socket.setKeepAlive(true);
        socket.setEncoding('utf8');

        let extraNonce = this.getExtraNonce();
        socket.minerData = {
            extraNonce : extraNonce,
            clientDiff : defaultDiff,
            authorized : false,
            userName : '',
            workerName : '',
            lastActivity : 0
        };
        this.activeMiners[extraNonce] = socket;

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
            this.freeExtraNonce(extraNonce);
            pushMessage = () => {
            };
        });
    }

    let server = net.createServer(socketConn);

    server.activeMiners = [];
    server.jobData = [null];

    server.getExtraNonce = function() {
        while (42) {
            // Candidate is between 0 and 2^24
            var candidate = Math.floor(Math.random() * Math.pow(2, 24)).toString(16);
            candidate = "0".repeat(6 - candidate.length) + candidate;
            if (! server.activeMiners[candidate]) {
                return candidate;
            }
        }
    };

    server.freeExtraNonce = function(extraNonce) {
        delete server.activeMiners[extraNonce];
    };

    server.setJob = function(data) {
        data = data.map(job => {
            job.blockTarget = BigInt(job.blockTarget);
            job.powHash = job.powHash.substr(2);
            job.seedHash = job.seedHash.substr(2);
            return job;
        });
        let topJob = data[data.length - 1];
        server.jobData = data;
        updateStates(topJob.blockHeight);
        broadcastJob();
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
        // Display job info
        let topJob = msg.data[msg.data.length - 1];
        console.log(new Date().toString() + ': New block #' + topJob.jobId + ' to mine at height ' + topJob.blockHeight + ' from ' + topJob.endpoint);

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
    let s = StratumServer(port, defaultStratumDiff, minStratumDiff, maxStratumDiff);
    process.on('message', async msg => {
        if (msg.sender && msg.sender == 'upstream') {
            s.setJob(msg.data);
        }
    });
    console.log('Stratum worker ' + process.pid + ' started');
}

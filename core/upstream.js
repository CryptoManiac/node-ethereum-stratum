// Upstreams
//  Must be able to support the websocket protocol
let upstreams = ['x.x.x.x:port', 'y.y.y.y:port'];

// Refresh interval and backlog
let refreshIntv = 1000;
let maxBackLog = 8;

const Web3 = require('web3');

let nodes = {}; // Upstream connection objects
let jobs = [];  // Job queue

function setJob(endpoint, package) {
    let blockHeight = Number(package[3]);
    let jobId = package[0].substr(package[0].length - 16);

    // Does it exist in the queue?
    if (jobs.findIndex(job => job.jobId == jobId) != -1) {
        return;
    }

    // Does the queue contain packages at greater height?
    if (jobs.findIndex(job => job.blockHeight > blockHeight) != -1) {
        return;
    }

    // Ignore new jobs at the identical height, except for updates sent by same node
    if (jobs.findIndex(job => job.blockHeight == blockHeight && job.endpoint != endpoint) != -1) {
        return;
    }

    // Get rid of obsolete jobs
    jobs = jobs.filter(job => job.blockHeight > (blockHeight - maxBackLog));

    // Add new job to queue
    jobs.push({ endpoint : endpoint, jobId : jobId, powHash : package[0], seedHash : package[1], blockTarget : package[2], blockHeight : blockHeight });

    // Send a copy of queue to master process
    process.send({ sender : 'upstream', kind : 'workdata', data : jobs });
}

function refreshWork() {
    for (let endpoint in nodes) {
        let web3 = nodes[endpoint];
        web3.eth.getWork().then(package => {
            setJob(endpoint, package);
        });
    }
}

function submitWork(jobId, nonce, mixHash, powHash) {
    let index = jobs.findIndex(job => job.jobId == jobId);
    if (index != -1) {
        let endpoint = jobs[index].endpoint;
        let web3 = nodes[endpoint];
        web3.eth.submitWork(nonce, powHash, mixHash).then(result => {
            console.log('Nonce ' + nonce + ' was ' + (!result ? 'not ' : '') + 'accepted by ' + endpoint);
        });
    } else {
        console.log('Obsolete job data', [jobId, nonce, mixHash]);
    }
}

function getWorkCallback(upstream, web3) {
    return (header) => {
        web3.eth.getWork().then(job => {
            setJob(upstream, job);
        });
    };
}

for (let i = 0; i < upstreams.length; ++i) {
    let endpoint = upstreams[i];
    let web3 = new Web3(new Web3.providers.WebsocketProvider('ws://' + endpoint));

    web3.eth.getWork().then(job => {
        nodes[endpoint] = web3;
        setJob(endpoint, job);
        web3.eth.subscribe('newBlockHeaders').on('data', getWorkCallback(endpoint, web3));
    });
}

setInterval(() => { refreshWork(); }, refreshIntv);

process.on('message', async msg => {
    if (msg.kind == 'candidate') {
        console.log('Solution candidate received from ' + msg.creatorId + '@' + msg.creatorIp);
        submitWork(msg.jobId, msg.nonce, msg.mixHash, msg.powHash);
    }
});

const { fork } = require('child_process');

var upstream = fork('core/upstream.js');
var stratum = fork('core/stratum.js');

upstream.on('message', msg => {
    if (msg.sender == 'upstream' && msg.kind == 'workdata') {
        stratum.send(msg);
    }
});

stratum.on('message', msg => {
    if (msg.sender == 'worker') {
        if (msg.kind == 'candidate') {
            upstream.send(msg);
        }

        console.log(msg);
    }
});

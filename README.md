# node-ethereum-stratum

## What is it?

A prototype of multi-threaded stratum server which is speaking NiceHash's EthereumStratum protocol.
Please DO NOT USE in production.

## Dependencies

Main dependency is NodeJS 10.x because I rely on BigInt class to check shares validity.
Others are deasync, memdown and levelup modules, web3 api bindings and my fork of node-ethash.

## Notable issues

There is a randomly appearing issue with web3.js module:

https://github.com/ethereum/web3.js/issues/966


// https://gist.github.com/kevinbull/f1cbc5440aa713bd5c9e

function generateUnid(a) {
  return a ? (a ^ Math.random() * 16 >> a/4).toString(16) : ([1e10] + 1e10 + 1e9).replace(/[01]/g, generateUnid).toLowerCase()
}

module.exports = {
    generateUnid : generateUnid
};


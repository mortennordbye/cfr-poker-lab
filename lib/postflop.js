'use strict';
// The postflop engine that tools should use: the Rust-backed engine (engines/postflop) when it exists,
// otherwise the old JS engine (engines/postflop-js). Both export solveStats(params) -> stats with rootEv.
const fs = require('fs');
const path = require('path');
const rs = path.join(__dirname, '..', 'engines', 'postflop', 'index.js');
module.exports = fs.existsSync(rs) ? require(rs) : require('../engines/postflop-js');

// Jest (CJS) needs `require()`-able output; @tus/server, @tus/s3-store, @tus/utils
// and srvx ship ESM-only .mjs files. ts-jest does not compile .mjs, so this
// dedicated Babel config transpiles only those files to CommonJS for the test runner.
module.exports = {
  presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
};

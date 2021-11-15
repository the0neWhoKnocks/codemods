const { resolve } = require('path');

const ROOT = resolve(__dirname, '../');
const COMPONENTS = `${ROOT}/react/components`;

module.exports = {
  aliases: {
    COMPONENTS,
    ROOT,
    UTILS: `${ROOT}/utils`,
  },
  moduleReplacements: [
    [/conf\.app$/, /conf\.app$/, 'constants'],
    [/fetch$/, /.*/, '../utils/fetch'],
  ],
  outputPath: COMPONENTS,
};

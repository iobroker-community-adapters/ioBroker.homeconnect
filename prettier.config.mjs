// iobroker prettier configuration file
import prettierConfig from '@iobroker/eslint-config/prettier.config.mjs';

export default {
    ...prettierConfig,
    semi: true,
    trailingComma: 'all',
    singleQuote: true,
    printWidth: 120,
    useTabs: false,
    tabWidth: 2,
    endOfLine: 'lf',
    // uncomment next line if you prefer double quotes
    // singleQuote: false,
};
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      [
        'module-resolver',
        {
          root: ['./'],
          extensions: ['.js', '.jsx', '.json'],
          alias: {
            '@features': './src/features',
            '@shared': './src/shared',
            '@services': './src/services',
            '@navigation': './src/navigation',
            '@store': './src/store',
            '@lib': './src/lib',
            '@db': './src/db',
            '@components': './src/components',
            '@screens': './src/screens',
            '@theme': './src/theme',
          },
        },
      ],
    ],
  };
};

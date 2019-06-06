const webpack = require("webpack");
const slsw = require("serverless-webpack");
const BbPromise = require("bluebird");

module.exports = BbPromise.try(() => {
  return slsw.lib.serverless.providers.aws.getAccountId().then(accountId => ({
    mode: slsw.lib.webpack.isLocal ? "development" : "production",
    entry: slsw.lib.entries,
    target: "node",
    plugins: [
      new webpack.DefinePlugin({
        AWS_ACCOUNT_ID: `${accountId}`
      })
    ],
    module: {
      rules: [
        {
          test: /\.js$/,
          exclude: /node_modules/,
          loader: "babel-loader",
          query: {
            presets: ["@babel/preset-env"]
          }
        }
      ]
    }
  }));
});

module.exports = {
  target: "node",
  externals: [
    /aws-sdk/ // Available on AWS Lambda
  ],
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        loader: "babel-loader",
        query: {
          presets: [
            [
              "env",
              {
                target: { node: "8.10" },
                useBuiltIns: true,
                modules: false,
                loose: true
              }
            ],
            "stage-0"
          ]
        }
      }
    ]
  }
};

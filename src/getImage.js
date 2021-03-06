const AWS = require("aws-sdk");
const parser = require("ua-parser-js");
const _ = { get: require("lodash/get") };

const utilities = require("../utilities");
const config = require("../config");

const s3 = new AWS.S3();

function checkS3(key) {
  return new Promise((resolve, reject) => {
    s3.headObject({ Bucket: process.env.BUCKET, Key: key }, (err, metadata) => {
      if (err && ["NotFound", "Forbidden"].indexOf(err.code) > -1)
        return resolve();
      else if (err) {
        const e = Object.assign({}, config.errors.SOMETHING_WRONG, { err });
        return reject(e);
      }
      return resolve(metadata);
    });
  });
}

function getS3(key) {
  return new Promise((resolve, reject) => {
    s3.getObject({ Bucket: process.env.BUCKET, Key: key }, (err, data) => {
      if (err && err.code == "NotFound") return reject(config.errors.NOT_FOUND);
      else if (err) {
        const e = Object.assign({}, config.errors.SOMETHING_WRONG, { err });
        return reject(e);
      }
      const eTag = data.ETag;
      const contentType = data.ContentType;
      const lastModified = data.LastModified;
      const cacheControl = "max-age=31536000";

      const headers = {};
      if (eTag) headers["ETag"] = eTag;
      if (contentType) headers["Content-Type"] = contentType;
      if (lastModified) headers["Last-Modified"] = lastModified;
      if (cacheControl) headers["cache-control"] = cacheControl;

      const body = new Buffer(data.Body).toString("base64");

      return resolve({
        statusCode: 200,
        headers,
        body,
        isBase64Encoded: true
      });
    });
  });
}

function stripQueryParams(query) {
  query = query || {};
  const return_query = {};
  Object.keys(query)
    .filter(k => ["w", "h", "f", "q", "m", "b"].indexOf(k) > -1)
    .sort()
    .forEach(k => (return_query[k] = query[k]));
  return return_query;
}

function generateKey(image_path, query) {
  let key = image_path;
  const keys = Object.keys(query);
  if (query && keys.length > 0) {
    key += "?";
    keys.sort().forEach((k, i) => {
      key += `${k}=${query[k]}`;
      if (i !== keys.length - 1) key += "&";
    });
  }
  if (key[0] == "/") key = key.substring(1);
  return key;
}

function resize(data) {
  const lambda = new AWS.Lambda({ region: process.env.region });
  return new Promise((resolve, reject) =>
    lambda.invoke(
      {
        Payload: JSON.stringify(data),
        FunctionName: process.env.RESIZE_LAMBDA
      },
      (err, result) =>
        err
          ? reject(err)
          : result.FunctionError
          ? reject({ statusCode: 502, body: result.Payload })
          : resolve(result)
    )
  );
}

function processImage(image_path, query, destination_path) {
  image_path = image_path[0] == "/" ? image_path.substring(1) : image_path;
  return checkS3(image_path)
    .then(metadata => {
      if (!metadata) throw config.errors.NOT_FOUND;
      console.log(
        "s3 base",
        image_path,
        "exists but we need to process it into",
        destination_path
      );
      const lambda_data = {
        mime_type: metadata.ContentType,
        resize_options: utilities.parseQueryParameters(query),
        asset: image_path,
        destination: destination_path,
        bucket: process.env.BUCKET,
        storage_class: "REDUCED_REDUNDANCY"
      };
      return resize(lambda_data);
    })
    .then(() => getS3(destination_path));
}

function modifyQuery(event) {
  const newQuery = stripQueryParams(event.queryStringParameters);
  const queryIsBlank =
    Object.keys(newQuery).length === 0 && newQuery.constructor === Object;
  const userAgent = parser(event.headers["User-Agent"]);

  // Define and determine device either from custom Cloudfront header or origin request event.
  const mobileDevice =
    _.get(event.headers, "CloudFront-Is-Mobile-Viewer", "") === "true" ||
    userAgent.device.type === "mobile";

  const tabletDevice =
    _.get(event.headers, "CloudFront-Is-Tablet-Viewer", "") === "true" ||
    userAgent.device.type === "tablet";

  if (queryIsBlank) {
    if (mobileDevice || tabletDevice) {
      newQuery.w = 500;
      newQuery.q = 75;
    } else {
      newQuery.w = 700;
      newQuery.q = 85;
    }
  }

  return newQuery;
}

function modifyPath(path) {
  let newPath = path;
  const forwardSlashCount = (newPath.match(/\//g) || []).length;
  const newFolderName = "_optimized";
  const pathSplitIntoArray = newPath.split("/");

  if (forwardSlashCount === 1) {
    pathSplitIntoArray.unshift(newFolderName);
  } else {
    const newFolderNameIndex = pathSplitIntoArray.length - 1;
    pathSplitIntoArray.splice(newFolderNameIndex, 0, newFolderName);
  }

  const pathArrayFiltered = pathSplitIntoArray.filter(Boolean);
  const pathBackToString = pathArrayFiltered.join("/");
  newPath = pathBackToString;

  return newPath;
}

module.exports.handler = (event, context, callback) => {
  // If spaces exist in filename, revert '+' (replaced by S3) back to spaces to match original filename
  const pathWithSpaces = event.path.replace(/\+/g, " ");

  // Define flag variables to determine whether to process the image or serve directly
  const qualityParam = _.get(event, "queryStringParameters.q", "");
  const showOriginalImage = qualityParam === "original";
  const formatsRegex = /(\.(htm|pdf|js|zip|gz|txt)|\/font)/gi;
  const notImageFormat = pathWithSpaces.search(formatsRegex) !== -1;
  const dontProcess = notImageFormat || showOriginalImage;

  // Generate S3 key based on flags above
  const newQuery = dontProcess ? {} : modifyQuery(event);
  const newPath = dontProcess ? pathWithSpaces : modifyPath(pathWithSpaces);
  const key = generateKey(newPath, newQuery);

  return checkS3(key)
    .then(metadata => {
      if (metadata) return getS3(key).then(data => callback(null, data));
      else if (Object.keys(newQuery).length > 0) {
        return processImage(pathWithSpaces, newQuery, key).then(data =>
          callback(null, data)
        );
      }
      return callback(null, config.errors.NOT_FOUND);
    })
    .catch(e => {
      console.log(e);
      console.log(e.stack);
      callback(null, e);
    });
};

module.exports.stripQueryParams = stripQueryParams;
module.exports.generateKey = generateKey;

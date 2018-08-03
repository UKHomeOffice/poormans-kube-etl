"use strict"

const AWS = require("aws-sdk");
const R = require("ramda");
const Promise = require("bluebird");

const {S3_ACCESS_KEY, S3_SECRET_KEY, REGION} = process.env,
    client = Promise.promisifyAll(new AWS.S3({
        accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY, region: REGION
    }));

const getManifest = async (bucket, manifest_file = "manifest.json") => {

    return client.getObjectAsync({ Bucket: bucket, Key: manifest_file })
        .then(object => ({ data: JSON.parse(object.Body.toString("utf8")) }));

};

const getObjectHash = async (bucket, key) => {

    return client.headObjectAsync({ Bucket: bucket, Key: key })
        .then(object => object.ETag);

};

function checkManifest(bucket, manifestFilePath) {

    return getManifest(bucket, manifestFilePath).then((manifest) => {

        return Promise.all(R.map(isHashOk(bucket), manifest.data))
            .then(R.all(R.equals(true)));

    });
}

const isHashOk = R.curry((bucket, fileMetadata) => {

    return getObjectHash(bucket, fileMetadata.FileName)
        .then((hash) => R.equals(fileMetadata.SHA256, hash));
});

const getJobType = async (bucket, key) => {

    return client.listObjectsAsync({ Bucket: bucket, Prefix: key })
        .then((response) => {

            const objectMetadata = response.Contents;

            /*
            [
                ...
                {
                    Key: 'pending/1532355830/address/address_headers.csv.gz',
                    LastModified: 2018-08-01T13:32:16.000Z,
                    ETag: '"49cc9494d2c176269fc20e42b05ebd9c"',
                    Size: 120,
                    StorageClass: 'STANDARD'
                },
                ...
            ]
             */

            const jobTypeFilePath = R.path(["Key"], R.head(R.filter(isTxtFileObject, objectMetadata)));

            return getJobTypeFromPath(jobTypeFilePath);

        });

};

const getJobTypeFromPath = (path) => {

    const jobType = R.head(R.last(path.split("/")).split("."));

    if (!jobType) {

        console.error("jobType was not captured correctly");

        throw new Error("jobType was not captured correctly");
    }

    return jobType;
};

const isTxtFileObject = R.compose(R.test(/.txt$/), R.path(["Key"]));


module.exports = {
    getObjectHash,
    checkManifest,
    getJobType
};

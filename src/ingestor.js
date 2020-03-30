/*

.##....##.##.....##.########..########.........########.########.##......
.##...##..##.....##.##.....##.##...............##..........##....##......
.##..##...##.....##.##.....##.##...............##..........##....##......
.#####....##.....##.########..######...#######.######......##....##......
.##..##...##.....##.##.....##.##...............##..........##....##......
.##...##..##.....##.##.....##.##...............##..........##....##......
.##....##..#######..########..########.........########....##....########

This is the KUBE-ETL that manages the jobs that perform the ingestion of data into entity search.
At present we have two datastores; 'elastic' and 'neo4j'. The following script
basically executes 10 steps:

1) Keep looking into an s3 bucket for timestamped folders.
2) Take the oldest timestamped folder and wait for it to have a 'manifest.json' file in it.
3) Work out from the folder what kind of ingest it is 'delta' or 'bulk'.
4) Delete any jobs for that kind of ingest.
5) If it is a bulk trigger the ingests in parallel, if it is a delta, do neo4j first then elastic in series.
6) Wait for all the jobs to finish.
7) Give drone 1minute to trigger a rolling update.
8) Wait for all the pods to be ready after the rolling update.
9) Delete the ingest folder from s3.
10) Work out how long everything took, and write that to mongodb. Start the whole thing again.

*/

const R = require("ramda");
const moment = require("moment");
const async = require("async");
const { spawn, exec } = require("child_process");
const { insert: mongoClient } = require("./mongodb");
const s3 = require("./s3-client");
const {
  hasTimestampFolders,
  getIngestJobParams,
  getJobLabels,
  getStatus,
  getIngestFiles,
  getJobDuration,
  getPodStatus,
  getPodStartedAt,
  Times
} = require("./helpers");

const {
  BUCKET: Bucket,
  KUBE_SERVICE_ACCOUNT_TOKEN,
  NODE_ENV = "production"
} = process.env;

let timer = new Times();

const pollingInterval = NODE_ENV === "test" ? 10 : 1000 * 60;
let baseArgs = [
  "--namespace",
  "dacc-entitysearch-preprod",
  "--token",
  KUBE_SERVICE_ACCOUNT_TOKEN
];

if (NODE_ENV === "dev" || NODE_ENV === "test") {
  baseArgs = R.concat(
    ["--context", "acp-notprod_DACC", "-n", "dacc-entitysearch"],
    baseArgs
  );
}

/*
..######..########....###....########..########
.##....##....##......##.##...##.....##....##...
.##..........##.....##...##..##.....##....##...
..######.....##....##.....##.########.....##...
.......##....##....#########.##...##......##...
.##....##....##....##.....##.##....##.....##...
..######.....##....##.....##.##.....##....##...
*/

function start(waitForManifest) {
  console.log("Start function preprod logs v2");
  if (waitForManifest instanceof Error) {
    console.log("Wait for manifest error");
    enterErrorState();
  } else {
    s3.listObjectsV2(
      { Bucket, Prefix: "preprod/", Delimiter: "" },
      (err, folder) => {
        console.log("After listing the s3 objects");
        if (!folder) {
          console.log("Folder is NOT undefined");
          if (!folder.Contents.length) {
            console.log("Folder has content of length of zero or undefined");
          } else {
            console.log(
              "Folder has content of length: " + folder.Contents.length
            );
            folder.Contents.forEach(key => {
              console.log("key: " + key);
            });
          }
        }

        if (err) {
          console.error(JSON.stringify(err, null, 2));
          return setTimeout(() => start(waitForManifest), pollingInterval);
        } else if (!folder || !folder.Contents.length) {
          console.log("No folder condition");
          return setTimeout(() => start(waitForManifest), pollingInterval);
        } else if (!hasTimestampFolders(folder)) {
          console.log(hasTimestampFolders(folder));
          console.log(folder);
          console.log("No timestamped folders");
          return setTimeout(() => start(waitForManifest), pollingInterval);
        } else {
          console.log("Getting ingest params");
          const ingestParams = getIngestJobParams(folder);
          console.log(" After Getting ingest params");
          if (!ingestParams) {
            console.error("error in s3 bucket - check folders");
            return setTimeout(() => start(waitForManifest), pollingInterval);
          }
          console.log("Getting ingest files");
          const ingestFiles = getIngestFiles(ingestParams)(folder);
          timer.setIngestFiles(ingestFiles);

          console.log(
            `new ${ingestParams.ingestType} ingest detected in folder ${
              ingestParams.ingestName
            } - waiting for manifest file...`
          );

          waitForManifest(ingestParams, getOldJobs);
        }
      }
    );
  }
}

function waitForManifest(ingestParams, getOldJobs) {
  const { ingestName } = ingestParams;
  const manifestPrefix = `preprod/${ingestName}/manifest.json`;
  console.log("Wait for manifest function");

  s3.listObjectsV2(
    { Bucket, Prefix: manifestPrefix, Delimiter: "" },
    (err, { Contents }) => {
      !Contents.length
        ? setTimeout(
            () => waitForManifest(ingestParams, getOldJobs),
            pollingInterval
          )
        : getOldJobs(ingestParams, deleteOldJobs, enterErrorState);
    }
  );
}

function getOldJobs(ingestParams, deleteOldJobs, enterErrorState) {
  const { ingestType, ingestName } = ingestParams;
  const forIngestType =
    ingestType === "incremental" ? new RegExp(/-delta-/) : new RegExp(/-bulk-/);

  exec(
    `kubectl ${baseArgs.join(" ")} get jobs -o json`,
    (err, stdout, stderr) => {
      if (err) {
        console.error(err);
        return enterErrorState();
      }

      const jobsToDelete = getJobLabels(forIngestType)(JSON.parse(stdout));

      deleteOldJobs(
        ingestParams,
        jobsToDelete,
        createBulkJobs,
        createDeltaJobs
      );
    }
  );
}

function deleteOldJobs(
  { ingestType, ingestName },
  jobsToDelete,
  createBulkJobs,
  createDeltaJobs
) {
  const jobType = ingestType === "incremental" ? "delta" : ingestType;

  const currentNeoJob = R.pipe(
    R.filter(R.startsWith(`neo4j-${jobType}`)),
    R.head
  )(jobsToDelete);
  const currentElasticJob = R.pipe(
    R.filter(R.startsWith(`elastic-${jobType}`)),
    R.head
  )(jobsToDelete);

  if (currentNeoJob && currentElasticJob) {
    console.log(
      `${moment(new Date()).format(
        "MMM Do HH:mm"
      )}: delete jobs ${currentNeoJob} & ${currentElasticJob}`
    );
  }

  const deleteJobs = spawn(
    "kubectl",
    R.concat(baseArgs, ["delete", "jobs", currentNeoJob, currentElasticJob])
  );

  const jobs = [
    {
      db: "neo4j",
      name: `neo4j-${jobType}-${ingestName}`,
      cronJobName: `neo4j-${jobType}`,
      pods: ["neo4j-0"]
    },
    {
      db: "elastic",
      name: `elastic-${jobType}-${ingestName}`,
      cronJobName: `elastic-${jobType}`,
      pods: ["elasticsearch-0"]
    }
  ];

  deleteJobs.on("exit", () => {
    jobType === "bulk"
      ? createBulkJobs({ ingestType, ingestName }, jobs, waitForCompletion)
      : createDeltaJobs({ ingestType, ingestName }, jobs, waitForCompletion);
  });
}

/*
.......##..#######..########...######.
.......##.##.....##.##.....##.##....##
.......##.##.....##.##.....##.##......
.......##.##.....##.########...######.
.##....##.##.....##.##.....##.......##
.##....##.##.....##.##.....##.##....##
..######...#######..########...######.
*/

function checkRollingStatus(podName, jobStartTime, podReady) {
  exec(
    `kubectl ${R.join(" ", baseArgs)} get pods ${podName} -o json`,
    (err, stdout, stderr) => {
      if (err || stderr) {
        setTimeout(
          () => checkRollingStatus(podName, jobStartTime, podReady),
          pollingInterval
        );
      } else {
        const statusOk = getPodStatus(JSON.parse(stdout));
        const startedAt = getPodStartedAt(JSON.parse(stdout));
        const isNew = startedAt
          ? moment(startedAt).isAfter(jobStartTime)
          : startedAt;

        statusOk && isNew
          ? podReady()
          : setTimeout(
              () => checkRollingStatus(podName, jobStartTime, podReady),
              pollingInterval
            );
      }
    }
  );
}

function checkPodStatus(podName, podReady) {
  exec(
    `kubectl ${R.join(" ", baseArgs)} get pods ${podName} -o json`,
    (err, stdout, stderr) => {
      let ready;

      try {
        ready = getPodStatus(JSON.parse(stdout));
      } catch (err) {
        ready = false;
      }

      if (err || stderr || !ready) {
        setTimeout(() => checkPodStatus(podName, podReady), pollingInterval);
      } else {
        podReady();
      }
    }
  );
}

function checkJobStatus(jobName, jobComplete) {
  exec(
    `kubectl ${R.join(" ", baseArgs)} get jobs ${jobName} -o json`,
    (err, stdout, stderr) => {
      let ready;

      try {
        ready = getStatus(JSON.parse(stdout));
      } catch (err) {
        ready = false;
      }

      if (err || stderr || !ready) {
        setTimeout(() => checkJobStatus(jobName, jobComplete), pollingInterval);
      } else {
        jobComplete();
      }
    }
  );
}

function waitForPods(job, next) {
  const checks = R.map(podName => ready => checkPodStatus(podName, ready))(
    job.pods
  );
  async.parallel(checks, err => next(err));
}

function waitForRollingUpdate(job, timer, next) {
  const jobStartTime =
    job.db === "neo4j" ? timer.getNeoStart() : timer.getElasticStart();

  const checks = R.map(podName => ready =>
    checkRollingStatus(podName, jobStartTime, ready)
  )(job.pods);
  async.parallel(checks, err => next(err));
}

function runJob(job, timer, callback) {
  async.waterfall(
    [
      next => waitForPods(job, next),
      next => {
        const args = R.concat(baseArgs, [
          "create",
          "job",
          job.name,
          "--from",
          `cronjob/${job.cronJobName}`
        ]);

        const jobPod = spawn("kubectl", args);

        jobPod.on("exit", code => {
          const err =
            code !== 0
              ? new Error(`${job.name} exits with non zero code`)
              : null;
          next(err);
        });
      },
      next => {
        job.db === "neo4j" ? timer.setNeoStart() : timer.setElasticStart();

        console.log(
          `${moment(new Date()).format("MMM Do HH:mm")}: ${
            job.name
          } triggered :)`
        );

        checkJobStatus(job.name, next);
      },
      next => setTimeout(next, pollingInterval), //wait for drone to trigger a rolling update
      next => waitForRollingUpdate(job, timer, next) // wait for the updates to roll through the cluster
    ],
    err => {
      if (!err) {
        job.db === "neo4j" ? timer.setNeoEnd() : timer.setElasticEnd();

        console.log(
          `${moment(new Date()).format("MMM Do HH:mm")}: ${job.name} pods ready`
        );
      }

      callback(err);
    }
  );
}

function createBulkJobs(ingestParams, jobs, waitForCompletion) {
  const [neo4j, elastic] = jobs;

  async.parallel(
    [done => runJob(neo4j, timer, done), done => runJob(elastic, timer, done)],
    err => {
      waitForCompletion(err, ingestParams, timer, start);
    }
  );
}

function createDeltaJobs(ingestParams, jobs, waitForCompletion) {
  async.eachSeries(
    jobs,
    (job, done) => runJob(job, timer, done),
    err => {
      waitForCompletion(err, ingestParams, timer, start);
    }
  );
}

function enterErrorState() {
  if (process.env.NODE_ENV === "test") return true;
  setTimeout(enterErrorState, pollingInterval);
}

/*
.########.####.##....##.####..######..##.....##
.##........##..###...##..##..##....##.##.....##
.##........##..####..##..##..##.......##.....##
.######....##..##.##.##..##...######..#########
.##........##..##..####..##........##.##.....##
.##........##..##...###..##..##....##.##.....##
.##.......####.##....##.####..######..##.....##
*/

function waitForCompletion(err, { ingestType, ingestName }, timer, start) {
  if (err) return enterErrorState();

  const complete = timer.isComplete();

  if (!complete) {
    setTimeout(
      () => waitForCompletion(null, { ingestType, ingestName }, timer, start),
      pollingInterval
    );
  } else {
    const deleteParams = {
      Bucket,
      Delete: {
        Objects: timer.getIngestFiles(),
        Quiet: true
      }
    };

    s3.deleteObjects(deleteParams, err => {
      const ingestEndTime = moment(new Date());

      if (err) {
        console.error(
          `${ingestEndTime.format("MMM Do HH:mm")}: ${JSON.stringify(
            err,
            null,
            2
          )}`
        );
        start(err);
      } else {
        const store_ingest_details = {
          ingest: ingestName,
          type: ingestType,
          load_date: new Date(),
          readable_date: moment(new Date()).format("ddd MMM YYYY HH:mm"),
          neo_job_duration: getJobDuration(
            timer.getNeoStart(),
            timer.getNeoEnd()
          ),
          elastic_job_duration: getJobDuration(
            timer.getElasticStart(),
            timer.getElasticEnd()
          ),
          total_job_duration: getJobDuration(timer.getNeoStart(), ingestEndTime)
        };

        console.log(
          `${ingestEndTime.format("MMM Do HH:mm")}: ${JSON.stringify(
            store_ingest_details,
            null,
            4
          )}`
        );

        timer.reset();

        mongoClient(store_ingest_details).then(() => start(waitForManifest));
      }
    });
  }
}

module.exports = {
  start,
  waitForManifest,
  waitForCompletion,
  getOldJobs,
  deleteOldJobs,
  checkPodStatus,
  checkJobStatus,
  checkRollingStatus,
  waitForPods,
  runJob,
  createBulkJobs,
  createDeltaJobs,
  enterErrorState
};

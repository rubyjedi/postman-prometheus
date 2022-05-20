const client = require('prom-client')
const newman = require('newman')
const express = require('express')
const fs = require('fs')
const http = require('./http.js')

let collectionFile = process.env.COLLECTION_FILE || './collection.json'
const collectionUrl = process.env.COLLECTION_URL || ''
const envFile = process.env.ENVIRONMENT_FILE || ''
const envUrl = process.env.ENV_URL || ''
const port = process.env.PORT || '8080'
const runInterval = process.env.RUN_INTERVAL || '30'
const runIterations = process.env.RUN_ITERATIONS || '1'
const enableBail = process.env.ENABLE_BAIL || 'false'
const requestMetrics = process.env.ENABLE_REQUEST_METRICS || 'true'

let collectionName = ''
let resultSummary = {}

// Lifetime global counters
let runCount = 0
let iterationCount = 0
let reqCount = 0

// Create a Registry to register the metrics
const register = new client.Registry();
client.collectDefaultMetrics({
  app: 'postman_exporter',
  prefix: 'postman_exporter_',
  timeout: 10000,
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
  register
});

// Create a custom histogram metric
const httpRequestTimer = new client.Histogram({
  name: 'postman_exporter_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10] // 0.1 to 10 seconds
});

// Register the histogram
register.registerMetric(httpRequestTimer);

// --------------------------------------------------------------------------------
//
// Entrypoint and server startup is here....
//

const app = express()

app.get('/metrics', async (req, res) => {
  // Start the HTTP request timer, saving a reference to the returned method
  const end = httpRequestTimer.startTimer();
  // Save reference to the path so we can record it when ending the timer
  const route = req.route.path;

  res.setHeader('content-type', 'text/plain; charset=utf-8; version=0.0.4')

  let metricString = await register.metrics()
  try {
    metricString = addMetric(metricString, 'lifetime_runs_total', runCount, 'counter')
    metricString = addMetric(metricString, 'lifetime_iterations_total', iterationCount, 'counter')
    metricString = addMetric(metricString, 'lifetime_requests_total', reqCount, 'counter')
    metricString = addMetric(metricString, 'stats_iterations_total', resultSummary.run.stats.iterations.total)
    metricString = addMetric(metricString, 'stats_iterations_failed', resultSummary.run.stats.iterations.failed)
    metricString = addMetric(metricString, 'stats_requests_total', resultSummary.run.stats.requests.total)
    metricString = addMetric(metricString, 'stats_requests_failed', resultSummary.run.stats.requests.failed)
    metricString = addMetric(metricString, 'stats_tests_total', resultSummary.run.stats.tests.total)
    metricString = addMetric(metricString, 'stats_tests_failed', resultSummary.run.stats.tests.failed)
    metricString = addMetric(metricString, 'stats_test_scripts_total', resultSummary.run.stats.testScripts.total)
    metricString = addMetric(metricString, 'stats_test_scripts_failed', resultSummary.run.stats.testScripts.failed)
    metricString = addMetric(metricString, 'stats_assertions_total', resultSummary.run.stats.assertions.total)
    metricString = addMetric(metricString, 'stats_assertions_failed', resultSummary.run.stats.assertions.failed)
    metricString = addMetric(metricString, 'stats_transfered_bytes_total', resultSummary.run.transfers.responseTotal)
    metricString = addMetric(metricString, 'stats_resp_avg', resultSummary.run.timings.responseAverage)
    metricString = addMetric(metricString, 'stats_resp_min', resultSummary.run.timings.responseMin)
    metricString = addMetric(metricString, 'stats_resp_max', resultSummary.run.timings.responseMax)

    if (requestMetrics == 'true') {
      for (let execution of resultSummary.run.executions) {
        if (!execution.response) {
          continue
        }

        const labels = [
          {
            // eslint-disable-next-line camelcase
            request_name: execution.item.name,
          },
          {
            iteration: execution.cursor.iteration,
          },
        ]
        if (execution.response.code) {
          metricString = addMetric(metricString, 'request_status_code', execution.response.code, 'gauge', labels)
        }
        if (execution.response.responseTime) {
          metricString = addMetric(metricString, 'request_resp_time', execution.response.responseTime, 'gauge', labels)
        }
        if (execution.response.responseSize) {
          metricString = addMetric(metricString, 'request_resp_size', execution.response.responseSize, 'gauge', labels)
        }
        if (execution.response.status) {
          const statusOK = execution.response.status == 'OK' ? 1 : 0
          metricString = addMetric(metricString, 'request_status_ok', statusOK, 'gauge', labels)
        }

        let failedAssertions = 0
        let totalAssertions = 0
        // Include per request assertion metrics
        if (execution.assertions) {
          for (let a in execution.assertions) {
            totalAssertions++
            if (execution.assertions[a].error) {
              failedAssertions++
            }
          }
        }
        metricString = addMetric(metricString, 'request_failed_assertions', failedAssertions, 'gauge', labels)
        metricString = addMetric(metricString, 'request_total_assertions', totalAssertions, 'gauge', labels)
      }
    }

    res.send(metricString)

    // End timer and add labels
    end({ route, code: res.statusCode, method: req.method });
  } catch (err) {
    res.status(500).send('No result data to show, maybe the collection has not run yet')
  }
})

app.get('/', (req, res) => {
  // Start the HTTP request timer, saving a reference to the returned method
  const end = httpRequestTimer.startTimer();
  // Save reference to the path so we can record it when ending the timer
  const route = req.route.path;

  res.setHeader('content-type', 'text/plain')
  res.status(404).send('Nothing here, try /metrics')

  // End timer and add labels
  end({ route, code: res.statusCode, method: req.method });
})

app.listen(port, async () => {
  // COLLECTION_URL when set takes priority over COLLECTION_FILE
  if (collectionUrl) {
    logMessage(`Collection URL will be fetched and used ${collectionUrl}`)
    try {
      const httpClient = new http(collectionUrl, false)
      let resp = await httpClient.get('')
      fs.writeFileSync(`./downloaded-collection.tmp.json`, resp.data)
      // Note. Overwrite the COLLECTION_FILE setting if it was already set
      collectionFile = './downloaded-collection.tmp.json'
    } catch (err) {
      logMessage(`FATAL! Failed to download collection from URL\n ${JSON.stringify(err, null, 2)}`)
      process.exit(1)
    }
  }

  // ENV_URL when set takes priority over ENVIRONMENT_FILE
  if (envUrl) {
    logMessage(`Postman Environment file URL will be fetched and used ${envUrl}`)
    try {
      const httpClient = new http(envUrl, false)
      let resp = await httpClient.get('')
      fs.writeFileSync(`./downloaded-env.tmp.json`, resp.data)
      // Note. Overwrite the ENVIRONMENT_FILE setting if it was already set
      envFile = './downloaded-env.tmp.json'
    } catch (err) {
      logMessage(`FATAL! Failed to download environment from URL\n ${JSON.stringify(err, null, 2)}`)
      process.exit(1)
    }
  }

  if (!fs.existsSync(collectionFile)) {
    logMessage(`FATAL! Collection file '${collectionFile}' not found`)
    process.exit(1)
  }

  logMessage(`Newman runner started & listening on ${port}`)
  logMessage(`Collection will be run every ${runInterval} seconds`)

  runCollection()
  setInterval(runCollection, parseInt(runInterval * 1000))
})

//
// Monitoring and Prometheus functions
//

function runCollection() {
  logMessage(`Starting run of ${collectionFile}`)

  // Special logic to bring all env vars starting with POSTMAN_ into the run
  let postmanEnvVar = []
  for (let envVar in process.env) {
    if (envVar.startsWith('POSTMAN_')) {
      postmanEnvVar.push({
        // Remove the prefix
        key: envVar.replace('POSTMAN_', ''),
        value: process.env[envVar],
      })
    }
  }

  newman.run(
    {
      collection: require(collectionFile),
      iterationCount: parseInt(runIterations),
      bail: enableBail == 'true',
      environment: envFile,
      envVar: postmanEnvVar,
    },
    runComplete
  )
}

function runComplete(err, summary) {
  if (!summary) {
    logMessage(`ERROR! Failed to run collection, no summary was returned!`)
    return
  }

  // This post run loop is for logging of what happened and some data clean up
  for (let e in summary.run.executions) {
    logMessage(
      ` - Completed request '${summary.run.executions[e].item.name}' in ${summary.run.executions[e].response.responseTime} ms`
    )

    // Junk we don't want in data
    summary.run.executions[e].response.stream = '*REMOVED*'

    for (let a in summary.run.executions[e].assertions) {
      if (summary.run.executions[e].assertions[a].error) {
        logMessage(
          `ERROR! Request '${summary.run.executions[e].item.name}' - assertion failed: ${summary.run.executions[e].assertions[a].error.test}, Reason: ${summary.run.executions[e].assertions[a].error.message}`
        )

        // Junk we don't want in data
        summary.run.executions[e].assertions[a].error.message = '*REMOVED*'
        summary.run.executions[e].assertions[a].error.stack = '*REMOVED*'
      }
    }
  }
  fs.writeFileSync('debug.tmp.json', JSON.stringify(summary, null, 2))

  const time = summary.run.timings.completed - summary.run.timings.started
  logMessage(`Run complete, and took ${time}ms`)

  runCount++
  iterationCount += summary.run.stats.iterations.total
  reqCount += summary.run.stats.requests.total

  if (err) {
    logMessage(`ERROR! Failed to run collection ${err}`)
  }
  resultSummary = summary
  collectionName = summary.collection.name
}

function addMetric(metrics, name, value, type = 'gauge', labels = []) {
  metrics += `# TYPE postman_${name} ${type}\n`

  let labelsClone = [...labels]
  labelsClone.push({ collection: collectionName })

  let labelStr = ''
  for (let label of labelsClone) {
    let key = Object.keys(label)[0]
    let value = Object.values(label)[0]
    labelStr += `${key}="${value}",`
  }
  labelStr = labelStr.replace(/,\s*$/, '')

  metrics += `postman_${name}{${labelStr}} ${value}\n\n`
  return metrics
}

function logMessage(msg) {
  console.log(`### ${new Date().toISOString().replace('T', ' ').substr(0, 16)} ${msg}`)
}

const client = require('prom-client')
const newman = require('newman')
const express = require('express')
const fs = require('fs')
const http = require('./http.js')

const port = process.env.PORT || '8080'
const settingsFolder = './settings'

const defaultSettings = {
  collectionFile : process.env.COLLECTION_FILE || './collection.json',
  collectionUrl : process.env.COLLECTION_URL || '',
  envFile : process.env.ENVIRONMENT_FILE || '',
  envUrl : process.env.ENV_URL || '',
  runInterval : process.env.RUN_INTERVAL || '30',
  runIterations : process.env.RUN_ITERATIONS || '1',
  enableBail : process.env.ENABLE_BAIL || 'false',
  requestMetrics : process.env.ENABLE_REQUEST_METRICS || 'true',

  collectionName : '',
  resultSummary : {},

  // Lifetime global counters
  runCount : 0,
  iterationCount : 0,
  reqCount : 0,
}

let collectionWorkers = []

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
    // --------------------------------------------------------------------------------
    // Add per-collection stats...
    collectionWorkers.forEach(function(workerItem){
      let resultSummary = workerItem.settings.resultSummary
      let collectionName = workerItem.settings.collectionName

      let runCount = workerItem.settings.runCount
      let iterationCount = workerItem.settings.iterationCount
      let reqCount = workerItem.settings.reqCount

      metricString = addMetric(metricString, collectionName, 'lifetime_runs_total', runCount, 'counter')
      metricString = addMetric(metricString, collectionName, 'lifetime_iterations_total', iterationCount, 'counter')
      metricString = addMetric(metricString, collectionName, 'lifetime_requests_total', reqCount, 'counter')
  
      metricString = addMetric(metricString, collectionName, 'stats_iterations_total', resultSummary.run.stats.iterations.total)
      metricString = addMetric(metricString, collectionName, 'stats_iterations_failed', resultSummary.run.stats.iterations.failed)
      metricString = addMetric(metricString, collectionName, 'stats_requests_total', resultSummary.run.stats.requests.total)
      metricString = addMetric(metricString, collectionName, 'stats_requests_failed', resultSummary.run.stats.requests.failed)
      metricString = addMetric(metricString, collectionName, 'stats_tests_total', resultSummary.run.stats.tests.total)
      metricString = addMetric(metricString, collectionName, 'stats_tests_failed', resultSummary.run.stats.tests.failed)
      metricString = addMetric(metricString, collectionName, 'stats_test_scripts_total', resultSummary.run.stats.testScripts.total)
      metricString = addMetric(metricString, collectionName, 'stats_test_scripts_failed', resultSummary.run.stats.testScripts.failed)
      metricString = addMetric(metricString, collectionName, 'stats_assertions_total', resultSummary.run.stats.assertions.total)
      metricString = addMetric(metricString, collectionName, 'stats_assertions_failed', resultSummary.run.stats.assertions.failed)
      metricString = addMetric(metricString, collectionName, 'stats_transfered_bytes_total', resultSummary.run.transfers.responseTotal)
      metricString = addMetric(metricString, collectionName, 'stats_resp_avg', resultSummary.run.timings.responseAverage)
      metricString = addMetric(metricString, collectionName, 'stats_resp_min', resultSummary.run.timings.responseMin)
      metricString = addMetric(metricString, collectionName, 'stats_resp_max', resultSummary.run.timings.responseMax)

      if (workerItem.settings.requestMetrics == 'true') {
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
            metricString = addMetric(metricString, collectionName, 'request_status_code', execution.response.code, 'gauge', labels)
          }
          if (execution.response.responseTime) {
            metricString = addMetric(metricString, collectionName, 'request_resp_time', execution.response.responseTime, 'gauge', labels)
          }
          if (execution.response.responseSize) {
            metricString = addMetric(metricString, collectionName, 'request_resp_size', execution.response.responseSize, 'gauge', labels)
          }
          if (execution.response.status) {
            const statusOK = execution.response.status == 'OK' ? 1 : 0
            metricString = addMetric(metricString, collectionName, 'request_status_ok', statusOK, 'gauge', labels)
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
          metricString = addMetric(metricString, collectionName, 'request_failed_assertions', failedAssertions, 'gauge', labels)
          metricString = addMetric(metricString, collectionName, 'request_total_assertions', totalAssertions, 'gauge', labels)
        }
      }
    })
    // --------------------------------------------------------------------------------
    // ##### End of per-collection metrics

    res.send(metricString)

    // End timer and add labels
    end({ route, code: res.statusCode, method: req.method });
  } catch (err) {
    console.log(err)
    res.status(500).send('No result data to show, maybe the collection has not run yet.')
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
  logMessage(`Newman runner started & listening on ${port}`)

  // Multi-Collection Support takes precedence
  if (fs.existsSync(settingsFolder)) {
    let files = fs.readdirSync(settingsFolder)
    for (let settingsFile of files) {
      let settings = Object.assign({}, defaultSettings)
      settings.collectionFile = `${settingsFolder}/${settingsFile}`
      collectionWorkers.push(await initCollection(settings))
    }
  }

  // Else, Single-Collection behavior will be used.
  if (collectionWorkers.length==0) {
    collectionWorkers.push(await initCollection(Object.assign({}, defaultSettings)))
  }

  collectionWorkers.forEach(function(workerItem){
    logMessage(`Collection ${workerItem.settings.collectionFile} will be run every ${workerItem.settings.runInterval} seconds`)
    runCollection(workerItem)
    setInterval(function(){ runCollection(workerItem) }, parseInt(workerItem.settings.runInterval * 1000))
  })
})

// --------------------------------------------------------------------------------
//
// Monitoring and Prometheus functions
//


async function initCollection(collectionSettings) {
  // clone the defaultSettings so we can override if/when needed.
  let collectionWorker = { 
    settings: collectionSettings
  }


  // COLLECTION_URL when set takes priority over COLLECTION_FILE
  if (collectionWorker.settings.collectionUrl) {
    logMessage(`Collection URL will be fetched and used ${collectionWorker.settings.collectionUrl}`)
    try {
      const httpClient = new http(collectionWorker.settings.collectionUrl, false)
      let resp = await httpClient.get('')
      fs.writeFileSync(`./downloaded-collection.tmp.json`, resp.data)
      // Note. Overwrite the COLLECTION_FILE setting if it was already set
      collectionWorker.settings.collectionFile = './downloaded-collection.tmp.json'
    } catch (err) {
      logMessage(`FATAL! Failed to download collection from URL\n ${JSON.stringify(err, null, 2)}`)
      process.exit(1)
    }
  }

  // ENV_URL when set takes priority over ENVIRONMENT_FILE
  if (collectionWorker.settings.envUrl) {
    logMessage(`Postman Environment file URL will be fetched and used ${collectionWorker.settings.envUrl}`)
    try {
      const httpClient = new http(collectionWorker.settings.envUrl, false)
      let resp = await httpClient.get('')
      fs.writeFileSync(`./downloaded-env.tmp.json`, resp.data)
      // Note. Overwrite the ENVIRONMENT_FILE setting if it was already set
      collectionWorker.settings.envFile = './downloaded-env.tmp.json'
    } catch (err) {
      logMessage(`FATAL! Failed to download environment from URL\n ${JSON.stringify(err, null, 2)}`)
      process.exit(1)
    }
  }

  if (!fs.existsSync(collectionWorker.settings.collectionFile)) {
    logMessage(`FATAL! Collection file '${collectionWorker.settings.collectionFile}' not found`)
    process.exit(1)
  }

  return collectionWorker
}

function runCollection(workerItem) {
  logMessage(`Starting run of ${workerItem.settings.collectionFile}`)

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
      collection: require(workerItem.settings.collectionFile),
      iterationCount: parseInt(workerItem.settings.runIterations),
      bail: workerItem.settings.enableBail == 'true',
      environment: workerItem.settings.envFile,
      envVar: postmanEnvVar,
    },
    function(err, summary) {
      runComplete(workerItem, err, summary)
    }
  )
}

function runComplete(workerItem, err, summary) {
  if (!summary) {
    logMessage(`ERROR! Failed to run collection ${workerItem.settings.collectionFile}, no summary was returned!`)
    return
  }

  // This post run loop is for logging of what happened and some data clean up
  for (let e in summary.run.executions) {
    if (summary.run.executions[e].response === undefined) {
      logMessage(
        ` - Failed request '${summary.run.executions[e].item.name}' with ${summary.run.executions[e].requestError} `
      )
      continue
    }
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
  fs.writeFileSync(
    `${summary.collection.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_debug.tmp.json`,
    JSON.stringify(summary, null, 2)
  )

  const time = summary.run.timings.completed - summary.run.timings.started
  logMessage(`Run complete, and took ${time}ms`)

  workerItem.settings.runCount++
  workerItem.settings.iterationCount += summary.run.stats.iterations.total
  workerItem.settings.reqCount += summary.run.stats.requests.total

  if (err) {
    logMessage(`ERROR! Failed to run collection ${err}`)
  }
  workerItem.settings.resultSummary = summary
  workerItem.settings.collectionName = summary.collection.name
}

function addMetric(metrics, collectionName, name, value, type = 'gauge', labels = []) {
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

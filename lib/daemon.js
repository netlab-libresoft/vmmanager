var config = require('konphyg')(__dirname + '/../config');
var logger = require('nlogger').logger(module);
var controller = require('./controller');
var nimble = require('nimble');
var path = require('path');
var fs = require('fs');

var daemon_info = null;
var drivers = {};
var driverinfo = {};
var exiting = false;
var driver_count = 0;

var workCfg = config('workspace');

function boot() {
  nimble.series([
    function(callback) {
      logger.info("Install signal handlers.");

      process.on('SIGINT', function() {
        logger.warn('SIGINT signal received.');
        shutdown();
      });

      process.on('SIGHUP', function() {
        logger.warn('SIGHUP signal received');
        shutdown();
      });

      process.on('exit', function () {
        logger.info('Daemon ', daemon_info.name, ' exit.');
      });

      process.on('uncaughtException', function(err) {
        logger.error('Unmanaged error: ', err);
        //shutdown();
        //process.exit(1);
      });

      callback();
    },
    function(callback) {
      if (exiting) {
        logger.debug("Skipping drivers loading.");
        callback();
        return;
      }

      logger.info("Load drivers.");
      var driver_dir = path.join(__dirname, "drivers");

      fs.readdir(driver_dir, function(err, files) {
        if (err) {
          logger.error(err);
          throw err;
        }

        var count = 0;
        for (var i = 0; i < files.length; i++) {
          var module_dir = path.join(driver_dir, files[i]);
          fs.readFile(path.join(module_dir, 'package.json'), 'utf8',
            function(err, data) {
              if (err)
                logger.error(err);
              else {
                try {
                  var info = JSON.parse(data);
                  var Driver = require(module_dir);

                  if (!info.name) {
                    logger.warn("Missing name driver ", module_dir);
                    return
                  }

                  logger.debug("Found driver:\n", data);
                  if (driverinfo[info.name]) {
                    if (info.version > driverinfo[info.name].version) {
                      logger.warn("Replacing driver ", info.name, " v.",
                                                driverinfo[info.name].version);
                      logger.warn("Using driver ", info.name, " v.",
                                                                  info.version);
                      drivers[info.name] = new Driver;
                      driverinfo[info.name] = info;
                    } else
                      logger.debug("Ignored driver ", info.name,
                                              " v.", info.version, ". Using v.",
                                                driverinfo[info.name].version);
                  } else {
                    drivers[info.name] = new Driver;
                    driverinfo[info.name] = info;
                    driver_count++;
                  }
                } catch (err) {
                  logger.error(err);
                }
              }

              if (++count == files.length)
                callback();
          });
        }
      });
    },
    function(callback) {
      if (exiting) {
        logger.debug("Skipping drivers initialization.");
        callback();
        return;
      }

      logger.info("Start drivers.");
      var count = 0;
      for (var driver in drivers)
        drivers[driver].start(function(err) {
          if (err) {
            logger.debug("Unable to start driver ", driver);
            logger.error(err);
          } else if (exiting)
            drivers[driver].stop(function(err) {
              if (err) {
                logger.debug("Unable to stop driver ", driver);
                logger.error(err);
              }
            });

          if (++count == driver_count)
            callback();
        });
    },
    function(callback) {
      if (exiting) {
        callback();
        return;
      }

      var running = 0;
      for (var driver in drivers)
        if (drivers[driver].running()) {
          controller.add_driver(driver, drivers[driver]);
          running++;
        }

      if (running == 0) {
        logger.warn("No drivers loaded. Unable to attend requests");
        return;
      }

      logger.debug(running, " driver", (running > 1) ? "s " : " ", "started");
      callback();
    },
    function(callback) {
      if (exiting) {
        callback();
        return;
      }

      logger.info("Checking workspaces directory.");
      fs.exists(workCfg.path, function (exists) {
        if (exists)
          callback();
        else {
          logger.warn("Workspace directory does not exist.");
          logger.info("Creating working directory in ", workCfg.path);
          mkdir(workCfg.path, function(err) {
            if (err)
              logger.error(err);
            else
              callback();
          });
        }
      });
    },
    function(callback) {
      if (exiting) {
        logger.debug("Skipping workspaces loading.");
        callback();
        return;
      }

      logger.info("Loading workspaces.");
      fs.readdir(workCfg.path, function(err, files) {
        if (err) {
          logger.error(err);
          return;
        }

        if (files.length == 0) {
          logger.debug("No workspaces loaded.");
          callback();
          return;
        }

        var count = 0;
        for (var i = 0; i < files.length; i++)
          controller.load_workspace(path.join(workCfg.path, files[i]),
                                                                function(err) {
            if (err)
              logger.error(err);

            if (++count == files.length)
              callback();
          })
      });
    },
    function(callback) {
      if (exiting) {
        logger.debug("Skipping AMQP initialization.");
        return;
      }

      logger.info("Start AMQP stuff.");
      controller.start();
      callback();
    }
  ], function() {
    logger.info('Daemon ', daemon_info.name, ' is now running.');
  });
}

function recursive_mkdir(dir, array, index, callback) {
  if (index == array.length) {
    callback(null);
    return;
  }

  fs.exists(dir, function(exists) {
    if (exists) {
      dir = path.join(dir, array[++index]);
      recursive_mkdir(dir, array, index, callback);
    } else {
      fs.mkdir(dir, function(err) {
        if (err)
          callback(err);
        else {
          dir = path.join(dir, array[++index]);
          recursive_mkdir(dir, array, index, callback);
        }
      });
    }
  });
};

function mkdir(dir, callback) {
  var array = path.normalize(dir).split(path.sep);

  // array[0] is root directory
  recursive_mkdir(path.sep, array, 0, function(err) {
    callback(err);
  });
}

function shutdown() {
  var count = 0;
  exiting = true;

  nimble.series([
    function(callback) {
      logger.info("Stop plugins.");
      for (var driver in drivers)
        if (drivers[driver].running())
          drivers[driver].stop(function(err) {
            if (err) {
              logger.debug("Unable to stop driver ", driver);
              logger.error(err);
            }

            if (++count == driver_count)
              callback();
          });
        else if (++count == driver_count)
          callback();
    },
    function(callback) {
      logger.info("Stop AMQP stuff.");
      controller.stop(function() {
        callback();
      });
    }
  ], function() {
    logger.info('Daemon ', daemon_info.name, ' shut down.');
  });
}

function start() {
  var config_file = path.join(__dirname, "..", 'package.json');
  fs.readFile(config_file, 'utf8', function(err, data) {
    if (err) {
      logger.error(err);
      throw err;
    }
    daemon_info = JSON.parse(data);
    logger.info('Daemon ', daemon_info.name, ' version ',
                                             daemon_info.version, ' starting.');
    boot();
  });
}

exports.start = start;

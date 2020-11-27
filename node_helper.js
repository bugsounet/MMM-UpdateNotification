/** All credit to Michael Teeuw https://michaelteeuw.nl **/
/** modified by @bugsounet for TelegramBot, NPM_UPDATE checker support **/
/** and add auto-updater **/

const SimpleGit = require("simple-git")
const fs = require("fs")
const path = require("path")
const defaultModules = require(__dirname + "/../default/defaultmodules.js")
const Log = require(__dirname + "/../../js/logger.js")
const NodeHelper = require("node_helper")
var exec = require('child_process').exec
var spawn = require('child_process').spawn
const pm2 = require('pm2')
var log = (...args) => { /* do nothing */ }

module.exports = NodeHelper.create({
  start: function () {
    this.simpleGits = []
    this.config= {}
    this.updateTimer= null
    this.ForceCheck = false
    this.init = false
    console.log("[UN] MMM-UpdateNotification Version:", require('./package.json').version)
    console.log("[UN] MagicMirror is running on pid:", process.pid)
  },

  configureModules: function (modules) {
    // Push MagicMirror itself , biggest chance it'll show up last in UI and isn't overwritten
    // others will be added in front
    // this method returns promises so we can't wait for every one to resolve before continuing
    this.simpleGits.push({ module: "MagicMirror", git: SimpleGit(path.normalize(__dirname + "/../../")) })

    var promises = []

    modules.forEach(moduleName => {
      if (!this.ignoreUpdateChecking(moduleName)) {
        // Default modules are included in the main MagicMirror repo
        var moduleFolder = path.normalize(__dirname + "/../" + moduleName)
        try {
          log("Checking git for module: " + moduleName + " in " + moduleFolder)
          let stat = fs.statSync(path.join(moduleFolder, ".git"))
          promises.push(this.resolveRemote(moduleName, moduleFolder))
        } catch (err) {
          return console.log("[UN] err: " + err)
          // Error when directory .git doesn't exist
          // This module is not managed with git, skip
        }
      } else log("Ignore module: " + moduleName)
    })
    log("Total modules to Check:", promises.length)
    return Promise.all(promises)
  },

  socketNotificationReceived: function (notification, payload) {
    switch (notification) {
      case "CONFIG":
        this.config = payload
        if (this.config.debug) log = (...args) => { console.log("[UN]", ...args) }
        if (this.config.notification.sendReady) this.sendSocketNotification("WELCOME", process.pid)
        break
      case "MODULES":
        clearTimeout(this.updateTimer)
        this.updateTimer = null
        this.simpleGits = []
        var data = []
        this.configureModules(payload).then(async () => {
          data = await this.performFetch()
          this.sendSocketNotification("INITIALIZED", require('./package.json').version)
          this.sendStatus(data)
          this.scheduleNextFetch(this.config.updateInterval)
        })
        break
      case "DISPLAY_ERROR":
        console.log("[UN] Callbacks errors:\n\n" + payload)
        break
      case "UPDATE":
        this.updateProcess(payload)
        break
      case "FORCE_CHECK":
        this.ForceCheck = true
        this.updateForce(payload)
        break
      case "CLOSEMM":
        this.doClose()
        break
      case "RESTARTMM":
        this.restartMM()
        break
    }
  },

  resolveRemote: function (moduleName, moduleFolder) {
    return new Promise((resolve, reject) => {
      var git = SimpleGit(moduleFolder)
      git.getRemotes(true, (err, remotes) => {
        if (remotes.length < 1 || remotes[0].name.length < 1) {
          // No valid remote for folder, skip
          return resolve()
        }
        // Folder has .git and has at least one git remote, watch this folder
        this.simpleGits.unshift({ module: moduleName, git: git })
        resolve()
      })
    })
  },

  dataFetch: function (sg,nb) {
    return new Promise((resolve, reject) => {
      sg.git
        .fetch(err => {
          if (err) {
            log("Error: " + sg.module, err)
            resolve()
          }
        })
        .status((err, data) => {
          data.module = sg.module
          log("[" + (nb+1) + "/" + this.simpleGits.length +"] Scan:" , data.module)
          if (err) {
            log("Scan Error: " + data.module, err)
            resolve()
          } else {
            /** send ONLY needed info **/
            moduleGitInfo = {
              module: data.module,
              behind: data.behind,
              current: data.current,
              tracking: data.tracking
            }
            if (!moduleGitInfo.current || !moduleGitInfo.tracking) {
              log("Scan Infos not complete:", data.module)
            } else {
              log("Scan Infos:", moduleGitInfo)
            }
            resolve(moduleGitInfo)
          }
        })
    })
  },

  performFetch: function () {
    var moduleGitInfo = []
    var data = []
    if (this.ForceCheck) log("Force Scan Start")
    this.simpleGits.forEach((sg,nb) => { data.push(this.dataFetch(sg,nb)) })
    return Promise.all(data)
  },

  updateForce: async function (handler) {
    clearTimeout(this.updateTimer)
    var info = []
    info = await this.performFetch()
    if (this.ForceCheck) log("Force Scan End.")
    this.sendStatus(info)
    this.sendSocketNotification("SCAN_COMPLETE", handler)
    this.ForceCheck = false
    this.scheduleNextFetch(this.config.updateInterval)
  },
  /************************************************/

  scheduleNextFetch: function (delay) {
    if (delay < 60 * 1000) {
      delay = 60 * 1000
    }

    clearTimeout(this.updateTimer)
    this.updateTimer = setTimeout(async ()=> {
      var data = []
      data = await this.performFetch()
      this.sendStatus(data)
      this.scheduleNextFetch(this.config.updateInterval)
    }, delay)
  },

  ignoreUpdateChecking: function (moduleName) {
    // Should not check for updates for default modules
    if (defaultModules.indexOf(moduleName) >= 0) {
      return true
    }

    // Should not check for updates for ignored modules
    if (this.config.ignoreModules.indexOf(moduleName) >= 0) {
      return true
    }

    // The rest of the modules that passes should check for updates
    return false
  },

  sendStatus: function (data) {
    if (!data) return
    this.sendSocketNotification("STATUS", data)
  },

  /** update **/
  updateProcess: function (module) {
    if (module == "MagicMirror") {
      var modulePath = path.normalize(__dirname + "/../../")
    } else {
      var Path = path.normalize(__dirname + "/../")
      var modulePath = Path + module
      var Command= this.config.update.defaultCommand
    }
    this.config.updateCommands.forEach(updateCommand => {
      if (updateCommand.module == module) Command = updateCommand.command
    })

    exec(Command, {cwd : modulePath, timeout: this.config.update.timeout } , (error, stdout, stderr) => {
      if (error) {
        console.error(`[UN] exec error: ${error}`)
        if (this.config.notification.useTelegramBot && this.config.notification.useCallback) {
          var res = {'results': error.toString().split('\n')}
          var final = "Update logs of " + module + ":\n\n"
          res.results.forEach(value => {
            if (value) final += this.ExtraChars(this.StripColor(value)) + "\n"
          })
          final += "\n" + this.ExtraChars("[UN] Update error!") + "\n"
          this.sendSocketNotification("SendResult", final)
        }
        this.sendSocketNotification("ERROR_UPDATE" , module)
      } else {
        console.log(`[UN] Update logs of ${module}: ${stdout}`)
        if (this.config.notification.useTelegramBot && this.config.notification.useCallback) {
          /** trying to parse stdout to Telegram without errors ... it's horrible ! **/
          var res = {'results': stdout.split('\n')}
          var final = "Update logs of " + module + ":\n\n"
          res.results.forEach(value => {
            if (value) final += this.ExtraChars(this.StripColor(value)) + "\n"
          })
          final += "\n" + this.ExtraChars("[UN] Process update done, i do it... because you are so too lazy :)))") + "\n"
          this.sendSocketNotification("SendResult", final)
        }
        this.sendSocketNotification("UPDATED", module)
        if (this.config.update.autoRestart) {
          log("Process update done, i do it... because you are so too lazy :)))")
          setTimeout(() => this.restartMM(), 3000)
        } else {
          log("Process update done, don't forget to restart MagicMirror!")
          this.sendSocketNotification("NEEDRESTART")
        }
      }
    })
  },

  /** MagicMirror restart and stop **/
  restartMM: function() {
    if (this.config.update.usePM2) {
      pm2.restart(this.config.update.PM2Name, (err, proc) => {
        if (err) {
          console.log("[UN] " + err)
          if (this.config.notification.useTelegramBot) this.sendSocketNotification("SendResult", err.toString())
        }
      })
    }
    else this.doRestart()
  },

  doRestart: function() {
    /** if don't use PM2 and launched with mpn start **/
    /** but no control of it **/
    /** I add stopMM command on telegram to stop process **/
    /** @Saljoke is happy it's sooOOooOO Good ! **/
    console.log("Restarting MagicMirror...")
    var MMdir = path.normalize(__dirname + "/../../")
    const out = this.config.update.logToConsole ? process.stdout : fs.openSync('./MagicMirror.log', 'a')
    const err = this.config.update.logToConsole ? process.stderr : fs.openSync('./MagicMirror.log', 'a')
    const subprocess = spawn("npm start", {cwd: MMdir, shell: true, detached: true , stdio: [ 'ignore', out, err ]})
    subprocess.unref()
    process.exit()
  },

  doClose: function() {
    if (!this.config.update.usePM2) process.abort()
    else {
      pm2.stop(this.config.update.PM2Name, (err, proc) => {
        if (err) {
          console.log("[UN] " + err)
          if (this.config.notification.useTelegramBot) this.sendSocketNotification("SendResult", err.toString())
        }
      })
    }
  },

  /** remove ExtraChars for telegramBot markdown **/
  ExtraChars: function(str) {
    str = str.replace(/[\s]{2,}/g," ") // delete space doubles, and more
    str = str.replace(/^[\s]/, "") // delete space on the begin
    str = str.replace(/[\s]$/,"") // delete space on the end
    str = str.replace("|",":") // simple replace | to : for more visibility
    /** special markdown for Telegram **/
    str = str.replace(new RegExp("_", "g"), "\\_") //
    str = str.replace(new RegExp("\\*", "g"), "\\*")
    str = str.replace(new RegExp("\\[", "g"), "\\[")
    str = str.replace(new RegExp("`", "g"), "\\`")
    return str
  },

  /** remove only color **/
  StripColor: function(str) {
    str = str.replace(/\[(\[H\033\[2J|\d+;\d+H|\d+(;\d+;\d+(;\d+;\d+)?m|[m])|1K)|\[m/g, '')
    return str
  }

});

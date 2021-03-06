var level = require('level')
var hyperdrive = require('hyperdrive')
var config = require('application-config-path')
var fs = require('fs')
var path = require('path')
var mkdirp = require('mkdirp')
var collect = require('collect-stream')
var Swarm = require('discovery-swarm')
var swarmAddr = require('./swarm-addr')
var uniq = require('uniq')

var NETWORK = 'hyperdrive'

module.exports = function () {
  var root = config('peer-npm')
  mkdirp.sync(root)
  var drive = hyperdrive(level(path.join(root, 'packages.db')))

  var keys
  var archive
  if (fs.existsSync(path.join(root, 'keys.json'))) {
    keys = JSON.parse(fs.readFileSync(path.join(root, 'keys.json'), 'utf-8'))
    archive = drive.createArchive(keys.pub, { live: true })
    console.log('found existing keypair + archive: ' + keys.pub)

    // TODO: use base58 encoding for keys
    // var k = new Buffer(keys.pub, 'hex')
    // console.log(k)
    // var out = require('bs58').encode(k)
    // console.log(out)
    // console.log(keys.pub)
  } else {
    archive = drive.createArchive({live: true})
    keys = {
      pub: archive.key.toString('hex'),
      prv: archive.metadata.secretKey.toString('hex')
    }
    fs.writeFileSync(path.join(root, 'keys.json'), JSON.stringify(keys))
    console.log('created brand new keypair + archive: ' + keys.pub)
  }

  archive.list(function (err, entries) {
    console.log('--- current entries ---')
    entries = entries.filter(function (e) {
      return e.name.endsWith('.json')
    })
    entries = entries.map(function (e) {
      return e.name.substring(0, e.name.length - 5)
    })
    entries.sort()
    uniq(entries)
    entries.forEach(function (e) {
      console.log(e)
    })
    console.log('---')
  })

  function host () {
    var link = archive.key.toString('hex')

    var swarm = Swarm()
    swarm.listen()
    swarm.join(link)
    swarm.on('connection', function (connection, info) {
      console.log('[HOST] found a peer: ', info.id.toString('hex'))
      var r = archive.replicate()
      connection.pipe(r).pipe(connection)
      r.on('end', function () {
        console.log('replicated with peer to share', link)
      })
      r.on('error', function (err) {
        console.log('ERROR REPLICATION:', err)
      })
    })
    return swarm
  }

  // TODO: clean up archive when done
  function getArchive (key, done) {
    console.log('getting archive', key)
    var archive = drive.createArchive(key)
    done(null, archive)

    var swarm = Swarm()
    swarm.listen()
    swarm.join(key)
    swarm.on('connection', function (connection, info) {
      console.log('[PEER] found a peer: ', info.id.toString('hex'))
      var r = archive.replicate()
      connection.pipe(r).pipe(connection)
      r.on('end', function () {
        console.log('replicated with peer to share', key)
      })
      r.on('error', function (err) {
        console.log('ERROR REPLICATION:', err)
      })
    })
  }

  var swarm = host()

  this.isPeerPackage = function (pkg) {
    return swarmAddr.is(pkg)
  }

  this.writeTarball = function (pkg, filename, buffer, done) {
    filename = filename.replace(pkg, swarmAddr.build(pkg, NETWORK, keys.pub))
    var ws = archive.createFileWriteStream(filename)
    ws.on('end', done)
    ws.on('finish', done)
    ws.on('close', done)
    ws.write(buffer)
    ws.end()
    console.log('writing', filename)
  }

  this.writeMetadata = function (pkg, data, done) {
    var outname = swarmAddr.build(pkg, NETWORK, keys.pub)

    // rewrite FOO to FOO_hyperdrive_publickey
    data._id = outname
    data.name = outname
    Object.keys(data.versions).forEach(function (version) {
      var v = data.versions[version]
      v.name = outname
      var r = new RegExp(pkg, 'g')
      v.dist.tarball = v.dist.tarball.replace(r, outname)
    })

    // move swarmDependencies into dependencies
    moveSwarmDepsIntoRegularDeps(data)

    var ws = archive.createFileWriteStream(outname + '.json')
    ws.on('finish', done)
    ws.on('error', done)
    ws.on('close', done)
    ws.write(JSON.stringify(data))
    ws.end()
    console.log('writing', outname + '.json')
  }

  this.fetchMetadata = function (addr, done) {
    var key = swarmAddr.parse(addr).key
    getArchive(key, function (err, archive) {
      if (err) return done(err)
      var filename = addr + '.json'
      collect(archive.createFileReadStream(filename), function (err, data) {
        if (err) return done(err)
        var json = JSON.parse(data.toString())
        done(null, json)
      })
    })
  }

  this.fetchTarball = function (filename, done) {
    var idx = filename.lastIndexOf(swarmAddr.SEP)
    var pkg = filename.substring(idx+1, idx+64+1)

    getArchive(pkg, function (err, archive) {
      if (err) return done(err)
      var rs = archive.createFileReadStream(filename)
      done(null, rs)
    })
  }

  this.addUser = function (user, done) {
    // TODO: generate + write keypair
    done()
  }

  return this
}

function moveSwarmDepsIntoRegularDeps (data) {
  Object.keys(data.versions).forEach(function (version) {
    var v = data.versions[version]

    for (var key in v['swarmDependencies']) {
      v['dependencies'][key] = v['swarmDependencies'][key]
    }
  })
}


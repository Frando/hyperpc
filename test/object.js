var tape = require('tape')
var rpc = require('..')
var rpcify = require('../rpcify')
var pump = require('pump')

function MyClass (key) {
  if (!(this instanceof MyClass)) return new MyClass(key)

  this.key = key
  this.init = true
  this.prefix = ''
}

MyClass.prototype.setPrefix = function (prefix) {
  this.prefix = prefix
}

MyClass.prototype.getUpper = function (suffix, cb) {
  var str = this.prefix + this.key + suffix
  cb(str.toUpperCase())
}

MyClass.prototype._private = function () {}

tape('rpcify objects', function (t) {
  t.plan(2)
  var api = {
    upper: (str, cb) => cb(null, str.toUpperCase()),
    myclass: rpcify(MyClass)
  }

  var server = rpc(api, {name: 'server', log: true})
  var client = rpc(null, {name: 'client', log: true})

  pump(server, client, server)

  client.on('remote', (remote) => {
    var myobj1 = remote.myclass('moon')
    var myobj2 = remote.myclass('this')
    myobj1.setPrefix('hello ')

    myobj1.getUpper(' bye', (str) => t.equal(str, 'HELLO MOON BYE', 'first instance getUpper works!'))
    myobj2.getUpper(' works', (str) => t.equal(str, 'THIS WORKS', 'second instance getUpper works!'))
  })
})

tape('skip private', function (t) {
  t.plan(1)
  var api = {
    upper: (str, cb) => cb(null, str.toUpperCase()),
    myclass: rpcify(MyClass)
  }

  var server = rpc(api)
  var client = rpc(null)

  pump(server, client, server)

  client.on('remote', (remote) => {
    var myobj1 = remote.myclass('moon')
    t.equal(myobj1._private, undefined, 'private method skipped')
  })
})

tape('include private', function (t) {
  t.plan(1)
  var api = {
    upper: (str, cb) => cb(null, str.toUpperCase()),
    myclass: rpcify(MyClass, {skipPrivate: false})
  }

  var server = rpc(api)
  var client = rpc(null)

  pump(server, client, server)

  client.on('remote', (remote) => {
    var myobj1 = remote.myclass('moon')
    t.equal(typeof myobj1._private, 'function', 'private method not skipped')
  })
})

tape('limit api', function (t) {
  t.plan(2)
  var api = {
    upper: (str, cb) => cb(null, str.toUpperCase()),
    myclass: rpcify(MyClass, {methods: ['getUpper']})
  }

  var server = rpc(api)
  var client = rpc(null)

  pump(server, client, server)

  client.on('remote', (remote) => {
    var myobj1 = remote.myclass('moon')
    t.equal(typeof myobj1.getUpper, 'function', 'method included')
    t.equal(typeof myobj1.setPrefix, 'undefined', 'method skipped')
  })
})

tape('check access', function (t) {
  t.plan(3)
  var api = {
    upper: (str, cb) => cb(null, str.toUpperCase()),
    myclass: rpcify(MyClass, { check: check })
  }

  function check (obj, method, args) {
    if (method === 'setPrefix' && args[0] === 'forbidden') return false
    else return true
  }

  var server = rpc(api)
  var client = rpc(null)

  pump(server, client, server)

  client.on('remote', (remote) => {
    var myobj1 = remote.myclass('key')
    myobj1.setPrefix('foo')
    myobj1.getUpper('x', (str) => t.equal(str, 'FOOKEYX', 'normal prefix works'))
    myobj1.setPrefix('forbidden')
    myobj1.getUpper('x', (str) => t.equal(str, 'FOOKEYX', 'check worked'))
    myobj1.setPrefix('bar')
    myobj1.getUpper('x', (str) => t.equal(str, 'BARKEYX', 'normal prefix works again'))
  })
})

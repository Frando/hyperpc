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

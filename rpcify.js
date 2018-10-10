// var debug = require('debug')('rpcify')

function RPCify (obj, opts) {
  if (!obj) return null
  if (!(this instanceof RPCify)) return new RPCify(obj, opts)
  opts = opts || {}

  var defaults = {
    skipPrivate: true,
    include: null,
    exclude: [],
    override: {},
    factory: null,
    name: null,
    access: function () { return true }
  }

  if (obj.__hyperpc) {
    this.opts = Object.assign(defaults, obj.__hyperpc, opts)
  } else if (obj.prototype && obj.prototype.__hyperpc) {
    this.opts = Object.assign(defaults, obj.prototype.__hyperpc, opts)
  } else if (!obj.prototype && Object.getPrototypeOf(obj) && Object.getPrototypeOf(obj).__hyperpc) {
    this.opts = Object.assign(defaults, Object.getPrototypeOf(obj).__hyperpc, opts)
  } else {
    this.opts = Object.assign(defaults, opts)
  }

  this.access = this.opts.access
  this.override = this.opts.override
  this.cache = {}

  if (obj.prototype) {
    // 1. Class (prototype)

    if (opts.factory) this.factory = opts.factory
    else this.factory = makeDefaultFactory(obj)

    this.instance = null
    this.name = obj.name
    this.funcs = getAllFuncs(obj.prototype)
  } else {
    // 2. Object instance

    this.factory = null
    this.instance = obj
    this.name = Object.getPrototypeOf(obj).name
    this.funcs = getAllFuncs(obj)
  }

  var out = ['constructor']
  if (this.opts.exclude) out = out.concat(this.opts.exclude)

  this.filteredFuncs = this.funcs.filter(f => {
    if (this.opts.include && this.opts.include.indexOf(f) === -1) return false
    if (out.indexOf(f) !== -1) return false
    if (this.opts.skipPrivate && f.substr(0, 1) === '_') return false
    return true
  })
}

RPCify.prototype.toManifest = function () {
  var ret = {
    name: this.name,
    methods: this.filteredFuncs
  }
  // debug('manifest', ret)

  return ret
}

RPCify.prototype.makeNew = function (id, args) {
  // debug('makeNew', id, args)
  if (this.instance) return this.instance
  else {
    var obj = this.factory(...args)
    this.cache[id] = obj
  }
}

RPCify.prototype.makeCall = function (method, id, args) {
  var instance
  if (this.instance) instance = this.instance
  else if (id && this.cache[id]) instance = this.cache[id]
  else return null

  if (!this.access(instance, method, args)) return null

  if (this.opts.override[method]) {
    return this.opts.override[method].apply(instance, args)
  } else {
    return instance[method].apply(instance, args)
  }
  // debug('makeCall - call: %O', instance[method])
}

function makeDefaultFactory (Obj) {
  return function (...args) {
    return new Obj(...args)
  }
}

function getAllFuncs (obj) {
  var props = []
  var cur = obj

  while (Object.getPrototypeOf(cur)) {
    Object.getOwnPropertyNames(cur).forEach(prop => {
      if (props.indexOf(prop) === -1) props.push(prop)
    })
    cur = Object.getPrototypeOf(cur)
  }
  return props
}

module.exports = RPCify

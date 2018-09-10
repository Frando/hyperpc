
function RPCify (constructor, opts) {
  if (!(this instanceof RPCify)) return new RPCify(constructor, opts)

  this.Cr = constructor
  this.opts = Object.assign({
    skipPrivate: true,
    methods: null,
    factory: null,
    check: null
  }, opts)
  this.cache = {}
}

RPCify.prototype.toManifest = function () {
  var methods = []

  var keys
  if (this.opts.methods) keys = this.opts.methods
  else {
    keys = Object.keys(this.Cr.prototype).filter((key) => {
      if (this.opts.skipPrivate) return key.substr(0, 1) !== '_'
      else return true
    })
  }

  keys.forEach((key) => {
    if (typeof this.Cr.prototype[key] === 'function') {
      methods.push(key)
    }
  })

  var ret = {
    name: this.Cr.name,
    methods
  }
  return ret
}

RPCify.prototype.makeNew = function (id, args) {
  var obj
  if (this.opts.factory) {
    obj = this.opts.factory(...args)
  } else {
    obj = new this.Cr(...args)
  }
  this.cache[id] = obj
  return obj
}

RPCify.prototype.makeCall = function (method, args) {
  var [id, name] = method
  if (!this.cache[id]) return
  if (this.opts.check) {
    // todo: Implement returning errors from check callback.
    var result = this.opts.check(this.cache[id], name, args)
    if (!result) return
  }
  this.cache[id][name].apply(this.cache[id], args)
}

module.exports = RPCify

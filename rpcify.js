
function RPCify (constructor, opts) {
  if (!(this instanceof RPCify)) return new RPCify(constructor, opts)

  this.Cr = constructor
  this.opts = Object.assign({
    skipPrivate: true,
    include: null,
    exclude: [],
    override: {},
    factory: null,
    check: null
  }, opts)
  this.cache = {}
}

RPCify.prototype.toManifest = function () {
  var methods = []
  var keys

  var proto = this.Cr.prototype
  if (!proto) proto = Object.getPrototypeOf(this.Cr)

  if (this.opts.include) keys = this.opts.include
  else {
    keys = Object.keys(proto).filter((key) => {
      if (this.opts.include) {
        return this.opts.include.indexOf(key) !== -1
      }
      if (this.opts.skipPrivate && key.substr(0, 1) ==='_') {
        return false
      }
      if (this.opts.exclude.indexOf(key) !== -1) {
        return false
      }
      return true
    })
  }

  keys.forEach((key) => {
    if (typeof proto[key] === 'function') {
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
  if (this.opts.override[name]) {
    this.opts.override[name].apply(this.cache[id], args)
  } else {
    this.cache[id][name].apply(this.cache[id], args)
  }
}

module.exports = RPCify

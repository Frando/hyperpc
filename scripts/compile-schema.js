var protobuf = require('protocol-buffers')
var json = require('json-protobuf-encoding')
var p = require('path')
var fs = require('fs')

var base = p.join(__dirname, '..')
var schema = fs.readFileSync(p.join(base, 'schema.proto'))
var js = protobuf.toJS(schema, { encodings: {
  json: json()
}})

fs.writeFileSync(p.join(base, 'messages.js'), js)

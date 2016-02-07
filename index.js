var _ = require('lodash'),
  url = require('url'),
  path = require('path'),
  Promise = require('bluebird'),
  readFile = Promise.promisify(require('fs').readFile),
  request = Promise.promisify(require('request')),
  AWS = require('aws-sdk'),
  s3 = new AWS.S3()
  ;

var proxy = process.env['HTTPS_PROXY'] || process.env['https_proxy'];
if (proxy) {
  try {
    var agent = require('proxy-agent');
    s3.config.update({
      httpOptions: {
        agent: agent(proxy),
      },
    });
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') console.log('Install proxy-agent for proxy support.');
    else throw e;
  }
}

module.exports = function(options) {
  var template = options.template;
  var base = parseLocation(options.url);
  if (base.relative) throw "url cannot be relative";
  if (template) return recurse(base, template).return(template);
  else return include(base, options.url);
}

function recurse(base, object) {
  if (_.isArray(object)) return Promise.all(object.map(_.bind(recurse, this, base)));
  else if (_.isPlainObject(object)) {
    return Promise.all(_.values(object).map(_.bind(recurse, this, base))).then(function() {
      if (object["Fn::Include"]) {
        return include(base, object["Fn::Include"]).then(function(json) {
          delete object["Fn::Include"];
          _.extend(object, json);
        });
      }
    });
  }
  return Promise.resolve();
}

function include(base, args) {
  args = _.isPlainObject(args) ? args : {
    location: args,
    type: 'json',
  };
  var body, absolute, location = parseLocation(args.location);
  if (!location.protocol) location.protocol = base.protocol;
  if (location.protocol === 'file') {
    absolute = location.relative ? path.join(path.dirname(base.path), location.host, location.path || '') : [location.host, location.path].join('');
    body = readFile(absolute);
    absolute = location.protocol + '://' + absolute;
  } else if (location.protocol === 's3') {
    var basedir = path.parse(base.path).dir;
    var bucket = location.relative ? base.host : location.host,
      key = location.relative ? url.resolve(basedir + '/', location.raw) : location.path;
    key = key.replace(/^\//, '');
    absolute = location.protocol + '://' + [bucket, key].join('/');
    body = Promise.promisify(s3.getObject).call(s3, {
      Bucket: bucket,
      Key: key,
    }).get('Body');
  } else if (location.protocol.match(/^https?$/)) {
    var basepath = path.parse(base.path).dir + '/';
    absolute = location.relative ? url.resolve(location.protocol + '://' + base.host + basepath, location.raw) : location.raw;
    body = request({
      url: absolute,
    }).get('body');
  }
  if (args.type === 'json') {
    return body.then(JSON.parse).then(function(template) {
      return module.exports({
        template: template,
        url: absolute,
      }).return(template);
    });
  } else if (args.type === 'literal') {
    return body.then(function(template) {
      var lines = JSONifyString(template);

      if (_.isPlainObject(args.context)) {
        lines = lines.map(function(line) {
          var parts = [];
          line.split(/({{\w+?}})/g).map(function(line) {
            var match = line.match(/^{{(\w+)}}$/), value = match ? args.context[match[1]] : undefined;
            if (!match) return line;
            else if(_.isUndefined(value)) { return '' }
            else {
              return value;
            }
          }).forEach(function(part) {
            var last = parts[parts.length-1];
            if(_.isPlainObject(part) || _.isPlainObject(last) || !parts.length) {
              parts.push(part);
            } else if(parts.length) {
              parts[parts.length-1] = last + part;
            }
          });
          return parts.filter(function(part) { return part !== '' });
        });
      }
      return {
        "Fn::Join": ["", _.flatten(lines)]
      };
    });
  }

}

function JSONifyString(string) {
  var lines = [],
    split = string.toString().split(/(\r?\n)/);
  split.forEach(function(line, idx) {
    if (idx % 2) {
      lines[(idx - 1) / 2] = lines[(idx - 1) / 2] + line;
    } else {
      lines.push(line);
    }
  });
  return lines;
}

function parseLocation(location) {
  var parsed = location.match(/^(((\w+):)?\/\/)?(.*?)(\/(.*))?$/);
  return {
    protocol: parsed[3],
    host: parsed[4],
    path: parsed[5],
    relative: _.isUndefined(parsed[1]) ? true : false,
    raw: location,
  };
}

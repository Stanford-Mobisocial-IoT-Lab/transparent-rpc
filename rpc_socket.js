/* -*- mode: js; indent-tabs-mode: nil; -*- */
//
// Copyright (c) 2015 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.
"use strict";

const events = require('events');
const util = require('util');
const Q = require('q');

// this is a separate function to keep the environment clean
// and avoid spurious live objects
function make$free(obj, knownStubIds, id) {
    const prev$free = obj.$free;
    if (prev$free) {
        obj.$free = function() {
            knownStubIds.delete(id);
            return prev$free();
        }
    } else {
        obj.$free = function() {
            knownStubIds.delete(id);
        }
    }
}

class RpcSocket extends events.EventEmitter {
    constructor(socket) {
        super();
        this._socket = socket;
        this._knownStubs = new WeakMap;
        this._knownStubIds = new Map;
        this._knownProxies = new Map;
        this._pendingCalls = new Map;
        this._inCall = false;
        this._newObjects = [];
        this._callId = 0;
        this._ended = false;
        this._stubCnt = 0;

        this._socket.on('data', this._handleMessage.bind(this));

        this._socket.on('error', (err) => {
            this._failAllCalls();
            this.emit('error', err);
        });
        this._socket.on('end', () => this.emit('end'));
        this._socket.on('close', function(hadError) {
            this._ended = true;
            this.emit('close', hadError);
        }.bind(this));
    }

    end(callback) {
        this._socket.end(callback);
    }

    destroy() {
        this._socket.destroy();
    }

    _sendMetadata(stub) {
        if (this._inCall) {
            this._newObjects.push({control:'new-object', obj: stub.$rpcId,
                                   methods: stub.methods});
        } else {
            this._socket.write({control:'new-object', obj: stub.$rpcId,
                                methods: stub.methods});
        }
    }

    addStub(obj) {
        if (this._knownStubs.has(obj))
            return this._knownStubs.get(obj).$rpcId;

        if (!obj.$rpcMethods)
            throw new TypeError('Invalid stub object');

        let cnt = this._stubCnt ++;
        if (cnt >= (1 << 24))
            throw new RangeError('Too many stubs');

        const rpcId = (process.pid << 24) + cnt;
        const stub = new RpcStub(obj, rpcId);

        make$free(obj, this._knownStubIds, rpcId);

        // NOTE: we store the object, not the stub in knownStubIds
        // this guarantees that knownStubIds has no references to
        // the socket, which means the object has no references to
        // the socket either
        // the object has a reference to knownStubIds through the
        // environment of $free
        // if the object is alive, we can get to the RpcStub
        // using knownStubs
        this._knownStubs.set(obj, stub);
        this._knownStubIds.set(rpcId, obj);
        this._sendMetadata(stub);
        return stub.$rpcId;
    }

    _marshalArgument(arg) {
        if (typeof arg !== 'object' || arg === null)
            return arg;

        if (Array.isArray(arg)) {
            return arg.map(this._marshalArgument.bind(this));
        } else if (arg.$rpcId !== undefined) {
            if (this._knownProxies.has(arg.$rpcId))
                return {$rpcId:arg.$rpcId};
            throw new Error('Invalid object 0x' + arg.$rpcId.toString(16) + ', likely a proxy from a different socket');
        } else if (arg.$rpcMethods) {
            return {$rpcId: this.addStub(arg)};
        } else {
            return arg;
        }
    }

    _unmarshalArgument(arg) {
        if (typeof arg !== 'object' || arg === null)
            return arg;

        if (Array.isArray(arg)) {
            return arg.map(this._unmarshalArgument.bind(this));
        } else if (arg.$rpcId !== undefined) {
            const stub = this._knownStubIds.get(arg.$rpcId);
            if (stub !== undefined)
                return stub;
            const proxy = this._knownProxies.get(arg.$rpcId);
            if (proxy !== undefined)
                return proxy;
            throw new Error('Invalid object ' + arg.$rpcId);
        } else {
            return arg;
        }
    }

    _failAllCalls() {
        let err = new Error('Socket closed');
        for (let call of this._pendingCalls.values())
            call.reject(err);
        this._pendingCalls = new Map;
    }

    call(obj, method, args) {
        if (this._inCall)
            throw new Error('Re-entrant calls are not supported');
        if (this._ended)
            return Q.reject(new Error('Socket closed'));

        this._inCall = true;
        var marshalled = args.map(this._marshalArgument.bind(this));
        this._newObjects.forEach(function(obj) {
            this._socket.write(obj);
        }, this);
        this._newObjects = [];
        this._inCall = false;

        var id = this._callId++;
        var call = Q.defer();
        this._pendingCalls.set(id, call);
        this._socket.write({control:'call', id: id,
                            obj: obj, method: method,
                            params: marshalled});
        return call.promise;
    }

    getProxy(id) {
        return this._knownProxies.get(id);
    }

    _handleCall(msg) {
        if (msg.id === undefined) {
            console.error('Malformed method call');
            return;
        }

        Q.try(function() {
            if (!this._knownStubIds.has(msg.obj))
                throw new Error('Invalid object 0x' + msg.obj.toString(16));

            if (!Array.isArray(msg.params))
                throw new Error('Malformed method call');

            var stub = this._knownStubs.get(this._knownStubIds.get(msg.obj));
            var unmarshalled = msg.params.map(this._unmarshalArgument.bind(this));
            var method = msg.method;

            if (method.substr(0,4) === 'get ') {
                if (unmarshalled.length != 0)
                    throw new Error('Wrong number of arguments, expected 0');

                return stub.get([method.substr(4)]);
            } else if (method.substr(0,4) === 'set ') {
                if (unmarshalled.length != 1)
                    throw new Error('Wrong number of arguments, expected 1');

                stub.set([method.substr(4)], unmarshalled[0]);
            } else {
                return stub.call(method, unmarshalled);
            }
        }.bind(this)).then(function(reply) {
            if (msg.id !== null) {
                this._socket.write({control:'reply', id: msg.id,
                                    reply: this._marshalArgument(reply)});
            }
        }.bind(this)).catch(function(error) {
            if (msg.id !== null) {
                if (error.name === 'SyntaxError') {
                    console.error(error.stack);
                    this._socket.write({control:'reply', id: msg.id,
                                        error: 'SyntaxError',
                                        fileName: error.fileName,
                                        lineNumber: error.lineNumber,
                                        message: error.message});
                } else if (error.message) {
                    console.error(error.stack);
                    this._socket.write({control:'reply', id: msg.id,
                                        error: error.message});
                } else {
                    this._socket.write({control:'reply', id: msg.id,
                                        error: String(error)});
                }
            } else {
                console.error('Discarded error from RPC call: ' + error.message);
            }
        }.bind(this)).done();
    }

    _handleReply(msg) {
        if (msg.id === undefined || msg.id === null) {
            console.error('Malformed method reply');
            return;
        }

        if (!this._pendingCalls.has(msg.id)) {
            console.error(msg.id + ' is not a pending method call');
            return;
        }

        var call = this._pendingCalls.get(msg.id);
        this._pendingCalls.delete(msg.id);
        try {
            if (msg.error) {
                if (msg.error === 'SyntaxError')
                    throw new SyntaxError(msg.message, msg.fileName, msg.lineNumber);
                else
                    throw new Error(msg.error);
            }

            call.resolve(this._unmarshalArgument(msg.reply));
        } catch(e) {
            call.reject(e);
        }
    }

    _handleMessage(msg) {
        switch (msg.control) {
        case 'new-object':
            if (this._knownProxies.has(msg.obj))
                return;

            let proxy = new RpcProxy(this, msg.obj, msg.methods);
            this._knownProxies.set(msg.obj, proxy);
            proxy.$free = () => {
                this._knownProxies.delete(msg.obj);
            };
            return;

        case 'call':
            this._handleCall(msg);
            return;

        case 'reply':
            this._handleReply(msg);
            return;
        }
    }
}

var stubCnt = 1;

function isStubId(rpcId) {
    return rpcId >> 24 === process.pid;
}

function RpcStub(object, rpcId, methods) {
    if (!(this instanceof RpcStub)) return new RpcStub(object, methods);

    this.$rpcId = rpcId;
    this.object = object;
    this.methods = object.$rpcMethods;
}

RpcStub.prototype._validateCall = function(method) {
    if (this.methods.indexOf(method) < 0)
        throw new Error('Invalid method ' + method);
}

RpcStub.prototype.get = function(name) {
    this._validateCall('get ' + name);
    return this.object[name];
}

RpcStub.prototype.set = function(name, value) {
    // NOTE: not a typo here, 'get foo' allows both get and set of foo
    this._validateCall('get ' + name);
    this.object[name] = value;
}

RpcStub.prototype.call = function(method, args) {
    this._validateCall(method);
    return this.object[method].apply(this.object, args);
}

function RpcProxy(socket, id, methods) {
    if (!(this instanceof RpcProxy)) return new RpcProxy(socket);

    this.$rpcId = id;
    this._socket = socket;

    methods.forEach(function(method) {
        if (method.substr(0,4) === 'get ') {
            var name = method.substr(4);
            Object.defineProperty(this, name,
                                  { configurable: true,
                                    enumerable: true,
                                    get: function() {
                                        return this._socket.call(this.$rpcId, 'get ' + name, []);
                                    },
                                    set: function(v) {
                                        return this._socket.call(this.$rpcId, 'set ' + name, [v]);
                                    }
                                  });
        } else {
            this[method] = function() {
                return this._socket.call(this.$rpcId, method, Array.prototype.slice.call(arguments));
            };
        }
    }, this);
}

module.exports = {
    Socket: RpcSocket,
    Stub: RpcStub,
};

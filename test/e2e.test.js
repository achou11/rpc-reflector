// @ts-nocheck
const test = require('tape-async')
const { createClient, createServer } = require('..')
const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const intoStream = require('into-stream')
const ReadableError = require('readable-error')
const DuplexPair = require('native-duplexpair')
const { MessagePortPair } = require('./helpers')

const fixturePath = path.join(__dirname, 'fixtures/lorem.txt')
const fixtureBuf = fs.readFileSync(fixturePath)
const objectsFixture = fixtureBuf
  .toString()
  .split(' ')
  .map((text) => ({ text }))

const myApi = {
  add(a, b) {
    return a + b
  },
  prop: 'foo',
  objectProp: {
    foo: 'bar',
  },
  arrayProp: [1, 2, 3],
  booleanProp: true,
  symbolProp: Symbol('foo'),
  nullProp: null,
  undefinedProp: undefined,
  numberProp: 42,
  namespace: {
    sub(a, b) {
      return a - b
    },
    prop: 'bar',
  },
  deep: {
    nested: {
      mult(a, b) {
        return a * b
      },
    },
  },
  async getLlama() {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        resolve('llama')
      }, 200)
    })
  },
  async errorMethod() {
    return Promise.reject(new Error('TestError'))
  },
  createErrorStream() {
    return new ReadableError(new Error('TestError'))
  },
  createStringStream() {
    // Set highWaterMark to force chunking to ensure that concat works on client
    // (each chunk is sent as a separate message)
    return fs.createReadStream(fixturePath, {
      highWaterMark: 10,
      encoding: 'utf8',
    })
  },
  createBufferStream() {
    // Set highWaterMark to force chunking to ensure that concat works on client
    // (each chunk is sent as a separate message)
    return fs.createReadStream(fixturePath, { highWaterMark: 10 })
  },
  createObjectStream(o) {
    return intoStream.object(o)
  },
}

// Run tests with MessagePort
runTests(function setup(api, opts) {
  const { port1: serverMPort, port2: clientMPort } = new MessagePortPair()

  return {
    client: createClient(clientMPort, opts),
    server: createServer(api, serverMPort),
    clientMPort,
    serverMPort,
  }
})

// Run tests with Duplex Stream
runTests(function setup(api, opts) {
  const { socket1, socket2 } = new DuplexPair({ objectMode: true })

  const serverStream = socket1
  const clientStream = socket2

  return {
    client: createClient(clientStream, opts),
    server: createServer(api, serverStream),
    clientStream,
    serverStream,
  }
})

function runTests(setup) {
  test('Client is instance of EventEmitter', (t) => {
    const { client } = setup(myApi)
    t.ok(client instanceof EventEmitter)
    t.end()
  })

  test('Calls methods on server', async (t) => {
    const { client } = setup(myApi)
    t.plan(9)
    t.equal(await client.add(1, 2), 3, 'Sync method works')
    t.equal(await client.getLlama(), 'llama', 'Async method works')
    t.equal(
      await client.createStringStream(),
      fixtureBuf.toString(),
      'Readable stream as string works'
    )
    t.ok(
      fixtureBuf.equals(await client.createBufferStream()),
      'Readable buffer works'
    )
    t.deepEqual(
      await client.createObjectStream(objectsFixture),
      objectsFixture,
      'Readable stream as object works'
    )
    const arrayOfStrings = objectsFixture.toString().split(' ')
    t.deepEqual(
      await client.createObjectStream(arrayOfStrings),
      arrayOfStrings,
      'An object stream returns as an array of chunks, not as a concatenated string'
    )
    const arrayOfBuffers = objectsFixture.toString().split(' ').map(Buffer.from)
    t.deepEqual(
      await client.createObjectStream(arrayOfBuffers),
      arrayOfBuffers,
      'An object stream returns as an array of chunks, not as a concatenated buffer'
    )
    try {
      await client.errorMethod()
      t.fail('Should not reach here')
    } catch (err) {
      t.equal(err.message, 'TestError', 'Error from server is passed to client')
    }
    try {
      await client.createErrorStream()
      t.fail('Should not reach here')
    } catch (err) {
      t.equal(
        err.message,
        'TestError',
        'Error from server stream is passed to client'
      )
    }
  })

  test('Nested methods', async (t) => {
    const { client } = setup(myApi)
    t.plan(10)
    t.equal(await client.namespace.sub(5, 2), 3, 'nested method works')
    t.equal(await client.deep.nested.mult(2, 3), 6, 'deep nested works')
    try {
      await client.namespace.missingMethod('donkey?')
      t.fail('Should not get here')
    } catch (error) {
      t.true(error instanceof Error, 'Calling missing method threw')
      t.equal(
        error.message,
        'missingMethod is not defined',
        'Error message as expected'
      )
    }
    try {
      await client.deep.missingNameSpace.sub('donkey?')
      t.fail('Should not get here')
    } catch (error) {
      t.true(error instanceof Error, 'Calling with missing namespace threw')
      t.equal(
        error.message,
        'missingNameSpace is not defined',
        'Error message as expected'
      )
    }
    try {
      let horse
      // Need to await this separately, because otherwise the rejection is not caught
      try {
        horse = await client.deep.missingNameSpace('horse')
      } catch (e) {}
      await horse.sub('donkey?')
      t.fail('Should not get here')
    } catch (error) {
      t.true(error instanceof Error, 'Calling with missing namespace threw')
      t.ok(error.message.match('undefined'), 'Error message as expected')
    }
    try {
      await client.prop.oops('donkey?')
      t.fail('Should not get here')
    } catch (error) {
      t.true(error instanceof Error, 'Calling method on prop fails')
      t.equal(error.message, 'oops is not defined', 'Error message as expected')
    }
  })

  test('Calling non-existant methods rejects with error', async (t) => {
    const { client } = setup(myApi)

    try {
      await client.missingMethod('donkey?')
      t.fail('Should not get here')
    } catch (error) {
      t.true(error instanceof Error, 'Threw with error')
      t.equal(
        error.message,
        'missingMethod is not defined',
        'Error message as expected'
      )
    }
    t.end()
  })

  test('Closed server does not respond, client times out', async (t) => {
    const { client, server } = setup(myApi, { timeout: 200 })
    server.close()
    try {
      await client.add(1, 2)
    } catch (error) {
      t.true(error instanceof Error, 'Threw with error')
      t.true(error.message.includes('timed out'), 'Error message as expected')
    }
    t.end()
  })

  test('Properties can be accessed as async functions', async (t) => {
    const { client } = setup(myApi)
    const transferrableProps = [
      'prop',
      'objectProp',
      'arrayProp',
      'booleanProp',
      'nullProp',
      'undefinedProp',
      'numberProp',
    ]
    t.plan(transferrableProps.length)
    for (const prop of transferrableProps) {
      t.deepEqual(
        await client[prop](),
        myApi[prop],
        'property returns promise that resolves to property value'
      )
    }
  })

  test('Cannot call non-existent methods on properties', async (t) => {
    const { client } = setup(myApi)
    const transferrableProps = [
      'prop',
      'objectProp',
      'arrayProp',
      'booleanProp',
      'nullProp',
      'undefinedProp',
      'numberProp',
    ]
    t.plan(transferrableProps.length)
    for (const prop of transferrableProps) {
      try {
        t.deepEqual(
          await client[prop].missingMethod(),
          myApi[prop],
          'property returns promise that resolves to property value'
        )
        t.fail('Should not get here')
      } catch (error) {
        t.true(error instanceof Error, 'Threw with error')
      }
    }
  })

  test.skip('Can call call built-in methods on properties', async (t) => {
    const { client } = setup(myApi)
    const transferrableProps = [
      'prop',
      'objectProp',
      'arrayProp',
      'booleanProp',
      'nullProp',
      'undefinedProp',
      'numberProp',
    ]
    t.plan(transferrableProps.length)
    for (const prop of transferrableProps) {
      try {
        t.deepEqual(
          await client[prop].missingMethod(),
          myApi[prop],
          'property returns promise that resolves to property value'
        )
        t.fail('Should not get here')
      } catch (error) {
        t.true(error instanceof Error, 'Threw with error')
      }
    }
  })

  test('Nested properties can be accessed as async functions', async (t) => {
    const { client } = setup(myApi)
    t.equal(await client.namespace.prop(), 'bar', 'nested property works')
    t.end()
  })

  test('Attempting to access a symbol property throws an error', async (t) => {
    const { client } = setup(myApi)
    t.plan(2)
    try {
      await client.symbolProp()
      t.fail('Should not get here')
    } catch (error) {
      t.true(error instanceof Error, 'Threw with error')
      t.equal(
        error.message,
        "Property 'symbolProp' is a Symbol",
        'Error message as expected'
      )
    }
  })

  test('The server ignores subscribe and unsubscribe when handler is not an EventEmitter', async (t) => {
    const { client, clientStream } = setup({})
    client.on('myEvent', t.fail)
    client.off('myEvent', t.fail)
    client.namespace.on('myEvent', t.fail)
    client.namespace.off('myEvent', t.fail)
    setTimeout(t.end, 200)
  })

  test('Subscribes to events on server', (t) => {
    const emitterApi = new EventEmitter()
    const { client } = setup(emitterApi)
    const expected = ['param1', { other: true }]
    client.on('myEvent', (...args) => {
      t.deepEqual(args, expected)
      t.end()
    })
    process.nextTick(() => {
      // eslint-disable-next-line no-useless-call
      emitterApi.emit.apply(emitterApi, ['myEvent', ...expected])
    })
  })

  test('Nested props are emitters', (t) => {
    t.plan(2)
    const emitterApi = new EventEmitter()
    const { client } = setup({ namespace: emitterApi })
    const expected = ['param1', { other: true }]
    t.true(
      client.namespace instanceof EventEmitter,
      'nested prop is an event emitter'
    )
    client.namespace.on('myEvent', (...args) => {
      t.deepEqual(args, expected)
      t.end()
    })
    process.nextTick(() => {
      // eslint-disable-next-line no-useless-call
      emitterApi.emit.apply(emitterApi, ['myEvent', ...expected])
    })
  })

  test('Unsubscribes to events', (t) => {
    const emitterApi = new EventEmitter()
    const { client } = setup(emitterApi)
    let count = 0

    client.on('myEvent', function listener(...args) {
      if (count++ > 0) return t.fail('Called more than once')
      t.deepEqual(args, ['carrot'])
      client.off('myEvent', listener)
    })

    process.nextTick(() => {
      emitterApi.emit('myEvent', 'carrot')
      process.nextTick(() => {
        emitterApi.emit('myEvent', 'carrot')
        setTimeout(t.end, 200)
      })
    })
  })

  test('Removing a listener when one still exists does not unsubscribe', (t) => {
    const emitterApi = new EventEmitter()
    const { client } = setup(emitterApi)
    let count1 = 0
    let count2 = 0

    client.on('myEvent', function listener1(...args) {
      if (count1++ > 0) return t.fail('Called more than once')
      t.deepEqual(args, ['carrot'])
      client.off('myEvent', listener1)
    })

    client.on('myEvent', function listener2(...args) {
      if (count2++ === 0) return
      t.equal(count2, 2, 'Second listener was called twice')
    })

    process.nextTick(() => {
      emitterApi.emit('myEvent', 'carrot')
      process.nextTick(() => {
        emitterApi.emit('myEvent', 'carrot')
        setTimeout(t.end, 200)
      })
    })
  })

  test('Error events pass error object', (t) => {
    t.plan(2)
    const emitterApi = new EventEmitter()
    const { client } = setup(emitterApi)
    const expected = new Error('TestError')
    client.on('error', (error) => {
      t.ok(error instanceof Error, 'Error object is returned')
      t.equal(error.message, 'TestError', 'Error message is valid')
    })
    process.nextTick(() => {
      // eslint-disable-next-line no-useless-call
      emitterApi.emit.apply(emitterApi, ['error', expected])
    })
  })

  test('once works', (t) => {
    const emitterApi = new EventEmitter()
    const { client } = setup(emitterApi)
    let count = 0

    client.once('myEvent', function listener(...args) {
      if (count++ > 0) return t.fail('Called more than once')
      t.deepEqual(args, ['carrot'])
    })

    process.nextTick(() => {
      emitterApi.emit('myEvent', 'carrot')
      process.nextTick(() => {
        emitterApi.emit('myEvent', 'carrot')
        process.nextTick(() => {
          t.equal(
            emitterApi.eventNames().length,
            0,
            'No more listeners on server'
          )
          setTimeout(t.end, 200)
        })
      })
    })
  })

  test('Other EventEmitter methods work', (t) => {
    const emitterApi = new EventEmitter()
    const { client } = setup(emitterApi)
    const noop = () => {}
    client.on('myEvent', noop)
    t.deepEqual(client.eventNames(), ['myEvent'])
    t.equal(
      client.getMaxListeners(),
      emitterApi.getMaxListeners(),
      'getMaxListeners() works'
    )
    // client.setMaxListeners(5)
    // t.equal(client.getMaxListeners(), 5)
    // t.equal(client.rawListeners('myEvent')[0], noop)
    t.end()
  })

  test('Closing server removes event listeners on server', (t) => {
    const emitterApi = new EventEmitter()
    const { client, server } = setup(emitterApi)

    client.on('myEvent', () => {})
    client.on('otherEvent', () => {})

    setTimeout(() => {
      t.equal(emitterApi.eventNames().length, 2)
      server.close()
      t.equal(emitterApi.eventNames().length, 0)
      t.end()
    }, 200)
  })

  test('Closing server removes nested event listeners on server', (t) => {
    const emitterApi = new EventEmitter()
    const { client, server } = setup({
      nested: emitterApi,
    })

    client.nested.on('myEvent', () => {})
    client.nested.on('otherEvent', () => {})

    setTimeout(() => {
      t.equal(emitterApi.eventNames().length, 2)
      server.close()
      t.equal(emitterApi.eventNames().length, 0)
      t.end()
    }, 200)
  })

  test('Closing the client stops it receiving messages from server', async (t) => {
    const { client } = setup(myApi, { timeout: 100 })
    t.equal(await client.add(1, 2), 3, 'Sync method works')
    createClient.close(client)
    try {
      await client.add(1, 2)
    } catch (err) {
      t.ok(/timed out/.test(err.message), 'Should fail with timeout')
    }
    t.end()
  })

  test('Non-string methods / props are not supported', (t) => {
    const { client } = setup(myApi)
    t.throws(() => client[Symbol('test')](), 'Calling a symbol method throws')
    t.end()
  })

  test('console.log on client does not throw', (t) => {
    const { client } = setup(myApi)
    // This was throwing without a trap for util.inspect.custom
    t.doesNotThrow(() => console.log(client))
    t.doesNotThrow(() => console.log(client.add))
    t.doesNotThrow(() => console.log(client.add()))
    t.end()
  })
}

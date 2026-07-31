/**
 * exFAT returns EISDIR from readlink() on a plain file; every other filesystem
 * returns EINVAL. webpack's resolver and Next's snapshot layer both treat
 * EINVAL as "not a symlink, carry on" and let EISDIR escape, so a build run
 * from an exFAT volume dies on the first module it resolves.
 *
 * This rewrites the errno back to the POSIX one. exFAT cannot store symlinks,
 * so a failed readlink there always means "not a symlink" anyway.
 *
 * Preloaded via NODE_OPTIONS=--require by scripts/next.ts, because Next's
 * bundled graceful-fs captures fs.readlink at require time — patching from
 * next.config.ts is already too late.
 */
const fs = require('node:fs')

const UV_EINVAL = -4071

function asEinval(e) {
  if (e && e.code === 'EISDIR') {
    e.code = 'EINVAL'
    e.errno = UV_EINVAL
    if (typeof e.message === 'string') {
      e.message = e.message.replace(
        'EISDIR: illegal operation on a directory',
        'EINVAL: invalid argument',
      )
    }
  }
  return e
}

const { readlinkSync, readlink } = fs
const readlinkPromise = fs.promises.readlink

fs.readlinkSync = function (...args) {
  try {
    return readlinkSync.apply(this, args)
  } catch (e) {
    throw asEinval(e)
  }
}

fs.readlink = function (...args) {
  const cb = args[args.length - 1]
  if (typeof cb === 'function') {
    args[args.length - 1] = (e, ...rest) => cb(e ? asEinval(e) : e, ...rest)
  }
  return readlink.apply(this, args)
}

fs.promises.readlink = function (...args) {
  return readlinkPromise.apply(this, args).catch((e) => {
    throw asEinval(e)
  })
}

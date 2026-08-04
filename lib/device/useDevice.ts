'use client'

import { useSyncExternalStore } from 'react'
import { deviceManager, type DeviceState } from './manager'

/**
 * Subscribe to the device singleton.
 *
 * `useSyncExternalStore` rather than context: the manager owns a socket that
 * has to outlive every component that renders it, and the snapshot is already
 * an immutable object replaced on change, which is exactly this hook's
 * contract.
 */
export function useDeviceState(): DeviceState {
  return useSyncExternalStore(
    deviceManager.subscribe,
    deviceManager.getSnapshot,
    deviceManager.getServerSnapshot,
  )
}

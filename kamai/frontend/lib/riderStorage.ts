import AsyncStorage from '@react-native-async-storage/async-storage'

import { supabase } from './supabase'

const EARNINGS_KEY_PREFIX = 'kamai_earnings_v2'
const LEGACY_EARNINGS_KEY = 'kamai_earnings_v1'

async function getAuthenticatedRiderId(): Promise<string> {
  const { data: { session }, error } = await supabase.auth.getSession()

  if (error) throw error
  if (!session?.user.id) throw new Error('You must be logged in to access rider data.')

  return session.user.id
}

export async function readRiderEarnings<T>(): Promise<T[]> {
  const riderId = await getAuthenticatedRiderId()
  const key = `${EARNINGS_KEY_PREFIX}:${riderId}`
  const raw = await AsyncStorage.getItem(key)
  return raw ? JSON.parse(raw) : []
}

export async function writeRiderEarnings<T>(entries: T[]): Promise<void> {
  const riderId = await getAuthenticatedRiderId()
  await AsyncStorage.setItem(`${EARNINGS_KEY_PREFIX}:${riderId}`, JSON.stringify(entries))
}

export async function getLegacyEarningsCount(): Promise<number> {
  const raw = await AsyncStorage.getItem(LEGACY_EARNINGS_KEY)
  if (!raw) return 0

  try {
    const entries = JSON.parse(raw)
    return Array.isArray(entries) ? entries.length : 0
  } catch {
    return 0
  }
}

export async function claimLegacyEarnings<T>(): Promise<T[]> {
  const riderId = await getAuthenticatedRiderId()
  const legacyRaw = await AsyncStorage.getItem(LEGACY_EARNINGS_KEY)
  if (!legacyRaw) return readRiderEarnings<T>()

  const legacyEntries: T[] = JSON.parse(legacyRaw)
  if (!Array.isArray(legacyEntries)) throw new Error('The old earnings data is not valid.')

  const scopedKey = `${EARNINGS_KEY_PREFIX}:${riderId}`
  const existingRaw = await AsyncStorage.getItem(scopedKey)
  const existingEntries: T[] = existingRaw ? JSON.parse(existingRaw) : []
  const merged = [...legacyEntries, ...existingEntries]

  // Remove the shared legacy copy only after the account-owned copy is saved.
  await AsyncStorage.setItem(scopedKey, JSON.stringify(merged))
  await AsyncStorage.removeItem(LEGACY_EARNINGS_KEY)

  return merged
}

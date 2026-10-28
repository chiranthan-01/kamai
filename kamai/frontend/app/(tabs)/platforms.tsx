/**
 * platforms.tsx — Platform Comparison + Time-Slot Intelligence
 *
 * CHANGED: Removed "Your typical weekly gross" input.
 * Reads the latest entry's gross from the authenticated rider's local history
 * so riders don't have to enter it twice.
 *
 * NEW (Session 4): When rider has 3+ entries tagged with slot data (from Calculator tab),
 * replaces hardcoded SLOT_MULTIPLIERS with their real per-slot effective rates.
 * Falls back to hardcoded estimates if not enough data.
 *
 * Sources: Fairwork India 2024 · Platform partner pages · CBDT
 */

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, StatusBar, Animated, KeyboardAvoidingView,
  Platform, ActivityIndicator,
} from 'react-native'
import {
  MIN_WAGE_HOURLY, CITY_LABELS, FAIRWORK_SCORES,
  PLATFORM_DATA, calculateEarnings,
} from '../../constants/kamai'
import { readRiderEarnings } from '../../lib/riderStorage'

// ─────────────────────────────────────────────
//  TYPES
// ─────────────────────────────────────────────
const PLATFORMS = ['zepto', 'blinkit', 'instamart'] as const
const CITIES    = ['bengaluru', 'delhi', 'chennai', 'kochi', 'thiruvananthapuram'] as const
type PlatformKey = (typeof PLATFORMS)[number]
type CityKey     = (typeof CITIES)[number]
type SlotKey     = 'morning' | 'afternoon' | 'evening' | 'night'

const DEFAULT_GROSS = 5000

// Minimum entries with slot data before we trust the rider's own rates
const MIN_SLOT_ENTRIES = 3

// ─────────────────────────────────────────────
//  TIME SLOTS
// ─────────────────────────────────────────────
const TIME_SLOTS: {
  key: SlotKey; label: string; sublabel: string; icon: string
  startHour: number; endHour: number
}[] = [
  { key: 'morning',   label: 'Morning Rush', sublabel: '7 AM – 11 AM', icon: '🌅', startHour: 7,  endHour: 11 },
  { key: 'afternoon', label: 'Afternoon',    sublabel: '11 AM – 4 PM', icon: '☀️', startHour: 11, endHour: 16 },
  { key: 'evening',   label: 'Evening Rush', sublabel: '4 PM – 9 PM',  icon: '🌆', startHour: 16, endHour: 21 },
  { key: 'night',     label: 'Late Night',   sublabel: '9 PM – 2 AM',  icon: '🌙', startHour: 21, endHour: 26 },
]

const PLATFORM_PACKAGES: Record<PlatformKey, string> = {
  zepto:     'com.zepto.delivery',
  blinkit:   'com.blinkit.partner',
  instamart: 'in.swiggy.deliveryapp',
}

// Hardcoded estimates — used only when rider doesn't have enough personal data yet
const SLOT_MULTIPLIERS_DEFAULT: Record<PlatformKey, Record<SlotKey, number>> = {
  zepto:     { morning: 1.15, afternoon: 0.90, evening: 1.35, night: 1.10 },
  blinkit:   { morning: 1.10, afternoon: 1.08, evening: 1.25, night: 0.88 },
  instamart: { morning: 1.05, afternoon: 1.00, evening: 1.18, night: 0.80 },
}

const PLATFORM_FACTS: Record<PlatformKey, {
  marketShare: string; radius: string; strength: string; payoutCycle: string
}> = {
  zepto:     { marketShare: '~26%', radius: '1–3 km',  strength: 'Surge pricing, tight radius', payoutCycle: 'Weekly' },
  blinkit:   { marketShare: '~46%', radius: '2–4 km',  strength: 'Highest order density',       payoutCycle: 'Weekly' },
  instamart: { marketShare: '~28%', radius: '3–5 km',  strength: 'Widest city coverage',        payoutCycle: 'Weekly' },
}

async function getSlotScreenTime(packageName: string, slot: (typeof TIME_SLOTS)[number]): Promise<number> {
  if (Platform.OS !== 'android') return 0
  try {
    const UsageStats = require('@brighthustle/react-native-usage-stats-manager').default
    let totalMs = 0
    const now = new Date()
    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
      const base = new Date(now)
      base.setDate(base.getDate() - dayOffset)
      const slotStart = new Date(base)
      slotStart.setHours(slot.startHour, 0, 0, 0)
      const slotEnd = new Date(base)
      if (slot.endHour > 24) {
        slotEnd.setDate(slotEnd.getDate() + 1)
        slotEnd.setHours(slot.endHour - 24, 0, 0, 0)
      } else {
        slotEnd.setHours(slot.endHour, 0, 0, 0)
      }
      const stats = await UsageStats.queryUsageStats(slotStart.getTime(), slotEnd.getTime())
      const app = stats?.find((s: { packageName: string; totalTimeInForeground: number }) => s.packageName === packageName)
      totalMs += app?.totalTimeInForeground ?? 0
    }
    return Math.round((totalMs / 1000 / 3600) * 10) / 10
  } catch {
    return 0
  }
}

async function getAllSlotData(): Promise<Record<PlatformKey, Record<SlotKey, number>>> {
  const result = {} as Record<PlatformKey, Record<SlotKey, number>>
  await Promise.all(
    PLATFORMS.map(async p => {
      result[p] = {} as Record<SlotKey, number>
      await Promise.all(TIME_SLOTS.map(async slot => {
        result[p][slot.key] = await getSlotScreenTime(PLATFORM_PACKAGES[p], slot)
      }))
    })
  )
  return result
}

// ─────────────────────────────────────────────
//  REAL SLOT RATES FROM HISTORY
//
//  For each (platform, slot) pair, finds all entries tagged with that slot,
//  computes: sum(true_take_home) / sum(hours) = real effective ₹/hr for that slot.
//  Returns a multiplier relative to the rider's own overall average rate.
//  If a slot has fewer than MIN_SLOT_ENTRIES entries, returns null → falls back to hardcoded.
// ─────────────────────────────────────────────
type SlotMultipliers = Record<PlatformKey, Record<SlotKey, number>>
type SlotDataQuality = Record<PlatformKey, Record<SlotKey, { count: number; realRate: number | null }>>

function computeRealSlotMultipliers(entries: any[]): {
  multipliers: SlotMultipliers
  quality: SlotDataQuality
  usingRealData: boolean
} {
  // Build quality map: per (platform, slot) → list of { true_take_home, hours }
  const buckets: Record<string, { takeHome: number; hours: number }[]> = {}

  for (const entry of entries) {
    if (!entry.slots || !Array.isArray(entry.slots) || entry.slots.length === 0) continue
    const p = entry.platform as PlatformKey
    if (!PLATFORMS.includes(p)) continue
    const slotCount = entry.slots.length

    for (const slotKey of entry.slots as SlotKey[]) {
      const key = `${p}:${slotKey}`
      if (!buckets[key]) buckets[key] = []
      // Distribute hours evenly across the slots tagged for this entry
      buckets[key].push({
        takeHome: (entry.true_take_home ?? 0) / slotCount,
        hours: (entry.hours ?? 0) / slotCount,
      })
    }
  }

  // Compute per-platform overall average rate (denominator for multiplier)
  const platformAvgRate: Record<PlatformKey, number | null> = {} as any
  for (const p of PLATFORMS) {
    const platformEntries = entries.filter(e => e.platform === p && (e.true_take_home ?? 0) > 0 && (e.hours ?? 0) > 0)
    if (platformEntries.length === 0) {
      platformAvgRate[p] = null
    } else {
      const totalTakeHome = platformEntries.reduce((s, e) => s + (e.true_take_home ?? 0), 0)
      const totalHours    = platformEntries.reduce((s, e) => s + (e.hours ?? 0), 0)
      platformAvgRate[p] = totalHours > 0 ? totalTakeHome / totalHours : null
    }
  }

  const multipliers = {} as SlotMultipliers
  const quality = {} as SlotDataQuality
  let anyRealData = false

  for (const p of PLATFORMS) {
    multipliers[p] = {} as Record<SlotKey, number>
    quality[p] = {} as Record<SlotKey, { count: number; realRate: number | null }>

    for (const slot of TIME_SLOTS) {
      const key = `${p}:${slot.key}`
      const bucket = buckets[key] ?? []
      const count = bucket.length

      if (count >= MIN_SLOT_ENTRIES && platformAvgRate[p] !== null && platformAvgRate[p]! > 0) {
        const totalTakeHome = bucket.reduce((s, b) => s + b.takeHome, 0)
        const totalHours    = bucket.reduce((s, b) => s + b.hours, 0)
        const realRate      = totalHours > 0 ? totalTakeHome / totalHours : null

        if (realRate !== null) {
          // Multiplier = rider's real slot rate / rider's overall average rate for that platform
          const mult = realRate / platformAvgRate[p]!
          // Clamp to reasonable range so one weird week doesn't distort everything
          multipliers[p][slot.key] = Math.max(0.5, Math.min(2.5, mult))
          quality[p][slot.key] = { count, realRate }
          anyRealData = true
        } else {
          multipliers[p][slot.key] = SLOT_MULTIPLIERS_DEFAULT[p][slot.key]
          quality[p][slot.key] = { count: 0, realRate: null }
        }
      } else {
        // Not enough data — use hardcoded estimate
        multipliers[p][slot.key] = SLOT_MULTIPLIERS_DEFAULT[p][slot.key]
        quality[p][slot.key] = { count, realRate: null }
      }
    }
  }

  return { multipliers, quality, usingRealData: anyRealData }
}

const fmt    = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const fmtHrs = (h: number) => h === 0 ? '—' : `${h}h`

function commissionMid(p: PlatformKey) {
  return (PLATFORM_DATA[p].commissionMin + PLATFORM_DATA[p].commissionMax) / 2
}
function appFeeMid(p: PlatformKey) {
  return (PLATFORM_DATA[p].appFeeMin + PLATFORM_DATA[p].appFeeMax) / 2
}

// ════════════════════════════════════════════════════════════
//  MAIN SCREEN
// ════════════════════════════════════════════════════════════
export default function PlatformsScreen() {
  const [city, setCity]             = useState<CityKey>('bengaluru')
  const [gross, setGross]           = useState<number>(DEFAULT_GROSS)
  const [grossLoaded, setGrossLoaded] = useState(false)
  const [activeSlots, setActiveSlots] = useState<Set<SlotKey>>(new Set(['morning', 'evening']))
  const [screenTimeData, setScreenTimeData] = useState<Record<PlatformKey, Record<SlotKey, number>> | null>(null)
  const [loadingScreenTime, setLoadingScreenTime] = useState(false)
  const [expanded, setExpanded] = useState<PlatformKey | null>(null)

  // ── NEW: real slot multipliers derived from earnings history ──
  const [slotMultipliers, setSlotMultipliers] = useState<SlotMultipliers>(SLOT_MULTIPLIERS_DEFAULT)
  const [slotQuality, setSlotQuality] = useState<SlotDataQuality | null>(null)
  const [usingRealData, setUsingRealData] = useState(false)

  const barAnims = useRef(
    Object.fromEntries(PLATFORMS.map(p => [p, new Animated.Value(0)])) as Record<PlatformKey, Animated.Value>
  ).current

  const scoreAnims = useRef(
    Object.fromEntries(PLATFORMS.map(p => [p, new Animated.Value(0)])) as Record<PlatformKey, Animated.Value>
  ).current

  // ── Load this rider's latest gross + compute their real slot rates ──
  useFocusEffect(
    useCallback(() => {
      async function loadFromStorage() {
        setGrossLoaded(false)
      try {
        const entries = await readRiderEarnings<any>()
        if (entries.length > 0) {
            // Latest gross
            const latest = entries[0]
            const totalGross = (latest.gross || 0) + (latest.bonus || 0)
            if (totalGross > 0) setGross(totalGross)

            // Real slot multipliers from full history
            const { multipliers, quality, usingRealData: hasReal } = computeRealSlotMultipliers(entries)
            setSlotMultipliers(multipliers)
            setSlotQuality(quality)
            setUsingRealData(hasReal)
        } else {
          setGross(DEFAULT_GROSS)
          setSlotMultipliers(SLOT_MULTIPLIERS_DEFAULT)
          setSlotQuality(null)
          setUsingRealData(false)
        }
      } catch (_) {}
      setGrossLoaded(true)
      }
      void loadFromStorage()
    }, []),
  )

  // ── Load screen time on mount (Android only) ──
  useEffect(() => {
    if (Platform.OS === 'android') {
      setLoadingScreenTime(true)
      getAllSlotData().then(data => {
        setScreenTimeData(data)
        setLoadingScreenTime(false)
        const detected = new Set<SlotKey>()
        PLATFORMS.forEach(p =>
          TIME_SLOTS.forEach(slot => {
            if ((data[p][slot.key] ?? 0) > 0.5) detected.add(slot.key)
          })
        )
        if (detected.size > 0) setActiveSlots(detected)
      })
    }
    PLATFORMS.forEach(p => scoreAnims[p].setValue(0))
    Animated.stagger(150,
      PLATFORMS.map(p =>
        Animated.timing(scoreAnims[p], { toValue: 1, duration: 700, useNativeDriver: false })
      )
    ).start()
  }, [])

  // ── Animate bars when gross or slots change ──
  useEffect(() => {
    PLATFORMS.forEach(p => barAnims[p].setValue(0))
    Animated.stagger(100,
      rankedPlatforms().map(p =>
        Animated.timing(barAnims[p], { toValue: 1, duration: 600, useNativeDriver: false })
      )
    ).start()
  }, [gross, activeSlots, slotMultipliers])

  // ── Uses real data if available, hardcoded estimates otherwise ──
  function slotAdjustedGross(p: PlatformKey): number {
    if (activeSlots.size === 0) return gross
    let totalMultiplier = 0
    let count = 0
    activeSlots.forEach(slotKey => {
      totalMultiplier += slotMultipliers[p][slotKey]
      count++
    })
    return gross * (count > 0 ? totalMultiplier / count : 1)
  }

  function getResults(p: PlatformKey) {
    return calculateEarnings({
      gross: slotAdjustedGross(p),
      bonus: 0,
      commissionPct: commissionMid(p),
      appFee: appFeeMid(p),
      fuel: 0,
      hours: 40,
      orders: 0,
      hasPan: true,
      quarterlyGross: gross * 13,
    })
  }

  function rankedPlatforms(): PlatformKey[] {
    return [...PLATFORMS].sort((a, b) => getResults(b).trueTakeHome - getResults(a).trueTakeHome)
  }

  const ranked  = rankedPlatforms()
  const winner  = ranked[0]
  const minWage = MIN_WAGE_HOURLY[city]

  function bestSlotForPlatform(p: PlatformKey): (typeof TIME_SLOTS)[number] {
    return TIME_SLOTS.reduce((best, slot) =>
      slotMultipliers[p][slot.key] > slotMultipliers[p][best.key] ? slot : best
    , TIME_SLOTS[0])
  }

  function bestPlatformForSlot(slotKey: SlotKey): PlatformKey {
    return PLATFORMS.reduce((best, p) =>
      slotMultipliers[p][slotKey] > slotMultipliers[best][slotKey] ? p : best
    , PLATFORMS[0])
  }

  function totalDetected(p: PlatformKey): number {
    if (!screenTimeData) return 0
    return TIME_SLOTS.reduce((sum, s) => sum + (screenTimeData[p][s.key] ?? 0), 0)
  }

  // How many slot-tagged entries does a rider have across all platforms?
  function totalSlotEntryCount(): number {
    if (!slotQuality) return 0
    let max = 0
    for (const p of PLATFORMS) {
      for (const slot of TIME_SLOTS) {
        max = Math.max(max, slotQuality[p][slot.key]?.count ?? 0)
      }
    }
    return max
  }

  // ─────────────────────────────────────────────
  //  RENDER
  // ─────────────────────────────────────────────
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <StatusBar barStyle="light-content" backgroundColor="#0F0F0F" />

        {/* ── Header ── */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Platforms</Text>
          <Text style={styles.headerSub}>Which one actually pays you more?</Text>
        </View>

        {/* ── City selector ── */}
        <Text style={styles.sectionLabel}>Your city</Text>
        <ScrollView
          horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingBottom: 4 }}
          style={{ marginBottom: 24 }}
        >
          {CITIES.map(c => (
            <TouchableOpacity
              key={c}
              style={[styles.chip, city === c && styles.chipActive]}
              onPress={() => setCity(c)}
            >
              <Text style={[styles.chipLabel, city === c && styles.chipLabelActive]}>
                {CITY_LABELS[c]}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* ── Weekly gross — pulled from Rider Profile ── */}
        <View style={styles.grossDisplayCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.grossDisplayLabel}>Your weekly gross</Text>
            <Text style={styles.grossDisplaySub}>
              {grossLoaded && gross === DEFAULT_GROSS
                ? 'Add entries in Calculate tab to personalise'
                : 'From your latest entry in Rider Profile'}
            </Text>
          </View>
          <Text style={styles.grossDisplayAmount}>
            {grossLoaded ? fmt(gross) : '…'}
          </Text>
        </View>
        <Text style={styles.hint}>
          Comparison adjusts to your actual earnings — not a generic number.
        </Text>

        {/* ── NEW: personalisation status banner ── */}
        {usingRealData ? (
          <View style={styles.personalBanner}>
            <Text style={styles.personalBannerIcon}>📊</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.personalBannerTitle}>Personalised from your history</Text>
              <Text style={styles.personalBannerBody}>
                Slot estimates below use your real earnings data — not platform averages.
                The more you log, the more accurate they get.
              </Text>
            </View>
          </View>
        ) : (
          <View style={styles.estimateBanner}>
            <Text style={styles.estimateBannerIcon}>💡</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.estimateBannerTitle}>Using platform averages</Text>
              <Text style={styles.estimateBannerBody}>
                Log {MIN_SLOT_ENTRIES}+ entries with time slots selected in the Calculate tab
                to see estimates based on your own earnings instead.
                {totalSlotEntryCount() > 0
                  ? ` You've logged ${totalSlotEntryCount()} so far.`
                  : ''}
              </Text>
            </View>
          </View>
        )}

        {/* ── TIME SLOT SELECTOR ── */}
        <Text style={[styles.sectionLabel, { marginTop: 20 }]}>When do you work?</Text>

        {Platform.OS === 'android' && loadingScreenTime && (
          <View style={styles.detectingRow}>
            <ActivityIndicator color="#10B981" size="small" />
            <Text style={styles.detectingText}>Reading your working hours from screen time…</Text>
          </View>
        )}

        {Platform.OS === 'android' && screenTimeData && (
          <View style={styles.screenTimeNotice}>
            <Text style={styles.screenTimeNoticeText}>
              📱 Auto-detected from your screen time this week
            </Text>
          </View>
        )}

        <View style={styles.slotGrid}>
          {TIME_SLOTS.map(slot => {
            const active = activeSlots.has(slot.key)
            const detectedHrs = screenTimeData
              ? PLATFORMS.reduce((sum, p) => sum + (screenTimeData[p][slot.key] ?? 0), 0)
              : 0
            const bestP = bestPlatformForSlot(slot.key)
            const bestPD = PLATFORM_DATA[bestP]
            // Show real data quality indicator if available
            const slotEntryCount = slotQuality
              ? Math.max(...PLATFORMS.map(p => slotQuality[p][slot.key]?.count ?? 0))
              : 0

            return (
              <TouchableOpacity
                key={slot.key}
                style={[styles.slotCard, active && styles.slotCardActive]}
                onPress={() => {
                  setActiveSlots(prev => {
                    const next = new Set(prev)
                    if (next.has(slot.key)) next.delete(slot.key)
                    else next.add(slot.key)
                    return next
                  })
                }}
                activeOpacity={0.75}
              >
                <View style={styles.slotTop}>
                  <Text style={styles.slotIcon}>{slot.icon}</Text>
                  {active && (
                    <View style={styles.slotActiveBadge}>
                      <Text style={styles.slotActiveBadgeText}>✓</Text>
                    </View>
                  )}
                </View>
                <Text style={[styles.slotLabel, active && styles.slotLabelActive]}>{slot.label}</Text>
                <Text style={styles.slotTime}>{slot.sublabel}</Text>
                {screenTimeData && detectedHrs > 0 && (
                  <Text style={styles.slotDetected}>{fmtHrs(detectedHrs)} detected</Text>
                )}
                {/* Show entry count if rider has data for this slot */}
                {slotEntryCount > 0 && (
                  <Text style={[
                    styles.slotEntryCount,
                    slotEntryCount >= MIN_SLOT_ENTRIES ? styles.slotEntryCountReal : styles.slotEntryCountPending,
                  ]}>
                    {slotEntryCount >= MIN_SLOT_ENTRIES
                      ? `✓ ${slotEntryCount} real entries`
                      : `${slotEntryCount}/${MIN_SLOT_ENTRIES} entries`}
                  </Text>
                )}
                <View style={[styles.slotBestBadge, { backgroundColor: bestPD.color + '25' }]}>
                  <View style={[styles.slotBestDot, { backgroundColor: bestPD.color }]} />
                  <Text style={[styles.slotBestText, { color: bestPD.color }]}>
                    {bestP === 'instamart' ? 'Instamart' : bestPD.label} best
                  </Text>
                </View>
              </TouchableOpacity>
            )
          })}
        </View>

        <Text style={styles.hint}>
          {usingRealData
            ? 'Based on your own earnings history. More entries = more accuracy.'
            : 'Surge patterns estimated from Fairwork India 2024 + platform partner data. Not live — verified weekly.'}
        </Text>

        {/* ── WINNER CARD ── */}
        {activeSlots.size > 0 && (
          <View style={[styles.winnerCard, { borderColor: PLATFORM_DATA[winner].color }]}>
            <View style={styles.winnerTop}>
              <View style={[styles.winnerBadge, { backgroundColor: PLATFORM_DATA[winner].color }]}>
                <Text style={styles.winnerBadgeText}>BEST FOR YOU</Text>
              </View>
              <View style={[styles.platformDot, { backgroundColor: PLATFORM_DATA[winner].color }]} />
              <Text style={[styles.winnerPlatform, { color: PLATFORM_DATA[winner].color }]}>
                {winner === 'instamart' ? 'Swiggy Instamart' : PLATFORM_DATA[winner].label}
              </Text>
            </View>
            <Text style={styles.winnerTakeHome}>
              {fmt(getResults(winner).trueTakeHome)}{' '}
              <Text style={styles.winnerTakeHomeSub}>estimated take-home</Text>
            </Text>
            <Text style={styles.winnerReason}>
              During your active slots, {winner === 'instamart' ? 'Instamart' : PLATFORM_DATA[winner].label}{' '}
              pays {((getResults(winner).trueTakeHome / getResults(ranked[ranked.length - 1]).trueTakeHome - 1) * 100).toFixed(0)}%
              more than {PLATFORM_DATA[ranked[ranked.length - 1]].label === 'Swiggy Instamart' ? 'Instamart' : PLATFORM_DATA[ranked[ranked.length - 1]].label}.
            </Text>
            <View style={styles.winnerSlotRow}>
              {Array.from(activeSlots).map(slotKey => {
                const slot = TIME_SLOTS.find(s => s.key === slotKey)!
                const mult = slotMultipliers[winner][slotKey]
                const q    = slotQuality?.[winner]?.[slotKey]
                return (
                  <View key={slotKey} style={styles.winnerSlotChip}>
                    <Text style={styles.winnerSlotIcon}>{slot.icon}</Text>
                    <Text style={styles.winnerSlotLabel}>{slot.label}</Text>
                    <Text style={[styles.winnerSlotMult, { color: PLATFORM_DATA[winner].color }]}>
                      {mult >= 1 ? '+' : ''}{((mult - 1) * 100).toFixed(0)}%
                    </Text>
                    {q?.realRate != null && (
                      <Text style={styles.winnerSlotReal}>real</Text>
                    )}
                  </View>
                )
              })}
            </View>
          </View>
        )}

        {/* ── TAKE-HOME BAR CHART ── */}
        <Text style={[styles.sectionLabel, { marginTop: 28 }]}>
          Estimated take-home comparison
        </Text>
        <Text style={styles.hint}>
          For {fmt(gross)} gross · adjusted for your working hours
        </Text>

        {ranked.map((p, idx) => {
          const pd = PLATFORM_DATA[p]
          const r  = getResults(p)
          const maxTakeHome = getResults(ranked[0]).trueTakeHome
          const barWidth = barAnims[p].interpolate({
            inputRange: [0, 1],
            outputRange: ['0%', `${Math.max(10, (r.trueTakeHome / maxTakeHome) * 100)}%`],
          })
          return (
            <View key={p} style={styles.compareRow}>
              <View style={styles.compareRowLeft}>
                <View style={[styles.platformDot, { backgroundColor: pd.color }]} />
                <Text style={styles.compareLabel}>
                  {p === 'instamart' ? 'Instamart' : pd.label}
                </Text>
                {idx === 0 && (
                  <View style={[styles.rankBadge, { backgroundColor: pd.color + '30' }]}>
                    <Text style={[styles.rankBadgeText, { color: pd.color }]}>BEST</Text>
                  </View>
                )}
              </View>
              <Text style={[styles.compareAmount, { color: pd.color }]}>{fmt(r.trueTakeHome)}</Text>
              <View style={styles.compareBarTrack}>
                <Animated.View style={[styles.compareBarFill, { width: barWidth, backgroundColor: pd.color + 'BB' }]} />
              </View>
              <Text style={styles.compareTax}>Platform takes {r.platformTaxRate.toFixed(1)}%</Text>
            </View>
          )
        })}

        {/* ── SLOT × PLATFORM GRID ── */}
        <Text style={[styles.sectionLabel, { marginTop: 32 }]}>Best platform per time slot</Text>
        <Text style={styles.hint}>
          {usingRealData
            ? 'Your real effective rate per slot — from your own earnings history'
            : 'Which platform earns more during each part of the day'}
        </Text>

        <View style={styles.slotPlatformTable}>
          <View style={[styles.tableRow, styles.tableHeaderRow]}>
            <Text style={[styles.tableCell, styles.tableHeaderCell, { flex: 1.4 }]}>Slot</Text>
            {PLATFORMS.map(p => (
              <View key={p} style={[styles.tableCell, { flex: 1, alignItems: 'center' }]}>
                <View style={[styles.platformDot, { backgroundColor: PLATFORM_DATA[p].color }]} />
              </View>
            ))}
          </View>

          {TIME_SLOTS.map(slot => {
            const bestP = bestPlatformForSlot(slot.key)
            return (
              <View key={slot.key} style={[styles.tableRow, activeSlots.has(slot.key) && styles.tableRowActive]}>
                <View style={[styles.tableCell, { flex: 1.4 }]}>
                  <Text style={styles.tableSlotIcon}>{slot.icon}</Text>
                  <Text style={styles.tableSlotLabel}>{slot.label}</Text>
                  <Text style={styles.tableSlotTime}>{slot.sublabel}</Text>
                </View>
                {PLATFORMS.map(p => {
                  const mult    = slotMultipliers[p][slot.key]
                  const isBest  = p === bestP
                  const pd      = PLATFORM_DATA[p]
                  const q       = slotQuality?.[p]?.[slot.key]
                  const isReal  = (q?.count ?? 0) >= MIN_SLOT_ENTRIES && q?.realRate != null
                  const detectedHrs = screenTimeData?.[p]?.[slot.key] ?? 0
                  return (
                    <View key={p} style={[styles.tableCell, { flex: 1, alignItems: 'center' }]}>
                      <Text style={[
                        styles.tableMultiplier,
                        isBest && { color: pd.color, fontWeight: '800' },
                        !isBest && { color: '#4B5563' },
                      ]}>
                        {mult >= 1 ? '+' : ''}{((mult - 1) * 100).toFixed(0)}%
                      </Text>
                      {isBest && <View style={[styles.tableBestDot, { backgroundColor: pd.color }]} />}
                      {isReal && <Text style={styles.tableRealBadge}>real</Text>}
                      {screenTimeData && detectedHrs > 0.3 && (
                        <Text style={styles.tableDetected}>{fmtHrs(detectedHrs)}</Text>
                      )}
                    </View>
                  )
                })}
              </View>
            )
          })}

          <View style={[styles.tableRow, { borderTopWidth: 1, borderTopColor: '#1F2937' }]}>
            <Text style={[styles.tableCell, styles.tableHeaderCell, { flex: 1.4 }]} />
            {PLATFORMS.map(p => (
              <Text key={p} style={[styles.tableCell, { flex: 1, fontSize: 9, color: PLATFORM_DATA[p].color, fontWeight: '700', textAlign: 'center' }]}>
                {p === 'instamart' ? 'Insta' : PLATFORM_DATA[p].label.toUpperCase()}
              </Text>
            ))}
          </View>
        </View>

        {/* Screen time breakdown (Android only) */}
        {screenTimeData && PLATFORMS.some(p => totalDetected(p) > 0) && (
          <>
            <Text style={[styles.sectionLabel, { marginTop: 32 }]}>Your screen time this week</Text>
            <Text style={styles.hint}>Hours each platform app was open — used to adjust the comparison above</Text>
            <View style={styles.screenTimeGrid}>
              {PLATFORMS.map(p => {
                const pd    = PLATFORM_DATA[p]
                const total = totalDetected(p)
                return (
                  <View key={p} style={styles.screenTimeCard}>
                    <View style={[styles.platformDot, { backgroundColor: pd.color, marginBottom: 8 }]} />
                    <Text style={[styles.screenTimePlatform, { color: pd.color }]}>
                      {p === 'instamart' ? 'Instamart' : pd.label}
                    </Text>
                    <Text style={styles.screenTimeTotal}>{fmtHrs(total)}</Text>
                    <Text style={styles.screenTimeTotalLabel}>total</Text>
                    {TIME_SLOTS.map(slot => {
                      const h = screenTimeData[p][slot.key] ?? 0
                      return h > 0 ? (
                        <View key={slot.key} style={styles.screenTimeSlotRow}>
                          <Text style={styles.screenTimeSlotIcon}>{slot.icon}</Text>
                          <Text style={styles.screenTimeSlotHrs}>{fmtHrs(h)}</Text>
                        </View>
                      ) : null
                    })}
                  </View>
                )
              })}
            </View>
          </>
        )}

        {/* ── PLATFORM DEEP DIVE CARDS ── */}
        <Text style={[styles.sectionLabel, { marginTop: 32 }]}>Platform breakdown</Text>

        {ranked.map((p, idx) => {
          const pd   = PLATFORM_DATA[p]
          const fw   = FAIRWORK_SCORES[p]
          const r    = getResults(p)
          const fact = PLATFORM_FACTS[p]
          const bestSlot = bestSlotForPlatform(p)
          const isOpen   = expanded === p
          const scoreWidth = scoreAnims[p].interpolate({
            inputRange: [0, 1],
            outputRange: ['0%', `${(fw.score / 10) * 100}%`],
          })

          return (
            <TouchableOpacity
              key={p}
              style={[styles.platformCard, idx === 0 && { borderColor: pd.color + '60' }]}
              onPress={() => setExpanded(isOpen ? null : p)}
              activeOpacity={0.9}
            >
              <View style={styles.cardHeader}>
                <View style={[styles.platformDot, { backgroundColor: pd.color, width: 10, height: 10, borderRadius: 5 }]} />
                <Text style={[styles.cardPlatformName, { color: pd.color }]}>
                  {p === 'instamart' ? 'Swiggy Instamart' : pd.label}
                </Text>
                {idx === 0 && (
                  <View style={[styles.cardBestBadge, { backgroundColor: pd.color }]}>
                    <Text style={styles.cardBestBadgeText}>BEST MATCH</Text>
                  </View>
                )}
                <Text style={styles.cardChevron}>{isOpen ? '▲' : '▼'}</Text>
              </View>

              <Text style={[styles.cardTakeHome, { color: pd.color }]}>{fmt(r.trueTakeHome)}</Text>
              <Text style={styles.cardTakeHomeSub}>
                estimated take-home · commission {commissionMid(p).toFixed(1)}% avg · app fee ₹{Math.round(appFeeMid(p))}/wk
              </Text>

              <View style={styles.scoreRow}>
                <Text style={styles.scoreLabel}>Fairwork 2024</Text>
                <View style={styles.scoreTrack}>
                  <Animated.View style={[styles.scoreFill, { width: scoreWidth, backgroundColor: pd.color }]} />
                </View>
                <Text style={[styles.scoreNumber, { color: pd.color }]}>{fw.score}/10</Text>
              </View>

              <View style={styles.pillRow}>
                <View style={[styles.pill, { backgroundColor: '#EF44441A', borderColor: '#EF444440' }]}>
                  <Text style={styles.pillText}>⚠ Fair Pay: FAILED</Text>
                </View>
                <View style={[styles.pill, fw.fairConditions
                  ? { backgroundColor: '#10B9811A', borderColor: '#10B98140' }
                  : { backgroundColor: '#EF44441A', borderColor: '#EF444440' }
                ]}>
                  <Text style={styles.pillText}>
                    {fw.fairConditions ? '✓' : '⚠'} Conditions: {fw.fairConditions ? 'PASS' : 'FAIL'}
                  </Text>
                </View>
              </View>

              {(() => {
                const hrRate = r.effectiveHourlyRate
                const above  = hrRate >= minWage
                return (
                  <View style={[styles.minWageRow, { backgroundColor: above ? '#10B98110' : '#EF444410' }]}>
                    <Text style={{ fontSize: 12 }}>{above ? '✅' : '⚠️'}</Text>
                    <Text style={[styles.minWageText, { color: above ? '#10B981' : '#EF4444' }]}>
                      {above ? 'Above' : 'Below'} {CITY_LABELS[city]} min wage (₹{minWage}/hr)
                    </Text>
                  </View>
                )
              })()}

              <View style={styles.bestSlotRow}>
                <Text style={styles.bestSlotIcon}>{bestSlot.icon}</Text>
                <Text style={styles.bestSlotText}>
                  Best on <Text style={{ color: pd.color, fontWeight: '700' }}>{bestSlot.label}</Text>
                  {' '}({bestSlot.sublabel}) · {slotMultipliers[p][bestSlot.key] >= 1 ? '+' : ''}{((slotMultipliers[p][bestSlot.key] - 1) * 100).toFixed(0)}% vs average
                  {slotQuality?.[p]?.[bestSlot.key]?.realRate != null ? ' (your real data)' : ' (estimate)'}
                </Text>
              </View>

              {isOpen && (
                <View style={styles.expanded}>
                  <View style={styles.expandedDivider} />
                  <View style={styles.expandedGrid}>
                    <ExpandedStat label="Market share"    value={fact.marketShare} />
                    <ExpandedStat label="Delivery radius" value={fact.radius} />
                    <ExpandedStat label="Incentive style" value={fact.strength} />
                    <ExpandedStat label="Payout cycle"    value={fact.payoutCycle} />
                    <ExpandedStat label="Commission"      value={`${commissionMid(p).toFixed(1)}% avg`} />
                    <ExpandedStat label="App fee"         value={`₹${Math.round(appFeeMid(p))}/wk`} />
                  </View>

                  <Text style={[styles.sectionLabel, { marginTop: 16, marginBottom: 10 }]}>
                    Your earnings by slot
                  </Text>
                  {TIME_SLOTS.map(slot => {
                    const mult = slotMultipliers[p][slot.key]
                    const q    = slotQuality?.[p]?.[slot.key]
                    const isReal = (q?.count ?? 0) >= MIN_SLOT_ENTRIES && q?.realRate != null
                    const slotGross = gross * mult
                    const slotResult = calculateEarnings({
                      gross: slotGross, bonus: 0,
                      commissionPct: commissionMid(p), appFee: appFeeMid(p),
                      fuel: 0, hours: 40, orders: 0, hasPan: true, quarterlyGross: gross * 13,
                    })
                    const detectedHrs = screenTimeData?.[p]?.[slot.key] ?? 0
                    const isWorking   = activeSlots.has(slot.key)
                    return (
                      <View key={slot.key} style={[styles.slotEarningRow, isWorking && { backgroundColor: '#10B98108' }]}>
                        <Text style={styles.slotEarningIcon}>{slot.icon}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.slotEarningLabel}>{slot.label}</Text>
                          <Text style={styles.slotEarningTime}>{slot.sublabel}</Text>
                          {isReal && q?.realRate != null && (
                            <Text style={styles.slotEarningReal}>
                              Your real rate: {fmt(q.realRate)}/hr · {q.count} entries
                            </Text>
                          )}
                          {!isReal && q && q.count > 0 && (
                            <Text style={styles.slotEarningPending}>
                              {q.count}/{MIN_SLOT_ENTRIES} entries — keep logging to personalise
                            </Text>
                          )}
                          {screenTimeData && detectedHrs > 0 && (
                            <Text style={styles.slotEarningDetected}>{fmtHrs(detectedHrs)} worked this week</Text>
                          )}
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={[styles.slotEarningAmount, { color: mult >= 1.2 ? pd.color : '#9CA3AF' }]}>
                            {fmt(slotResult.trueTakeHome)}
                          </Text>
                          <Text style={styles.slotEarningMult}>
                            {mult >= 1 ? '+' : ''}{((mult - 1) * 100).toFixed(0)}%
                            {isReal ? ' real' : ' est'}
                          </Text>
                        </View>
                      </View>
                    )
                  })}

                  <Text style={styles.expandedSource}>
                    Fairwork India 2024 · CBDT · Income Tax Act §194C · Partner pages
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          )
        })}

        {/* ── KEY INSIGHT ── */}
        <View style={styles.insightCard}>
          <Text style={styles.insightTitle}>Why none of them passed Fair Pay</Text>
          <Text style={styles.insightBody}>
            Fairwork India 2024 (Oxford University + IIITB) confirmed: Zepto scored 4/10,
            Blinkit and Instamart scored 6/10. All three scored 0 on Fair Pay — meaning
            none have proven riders earn even the government minimum wage after work-related costs.
            This is peer-reviewed research, not opinion.
          </Text>
          <Text style={styles.insightSource}>
            Fairwork India 2024 · fair.work/en/ratings/india/
          </Text>
        </View>

        <View style={{ height: 80 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

// ════════════════════════════════════════════════════════════
//  SUB-COMPONENTS
// ════════════════════════════════════════════════════════════

function ExpandedStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.expandedStatCell}>
      <Text style={styles.expandedStatLabel}>{label}</Text>
      <Text style={styles.expandedStatValue}>{value}</Text>
    </View>
  )
}

// ════════════════════════════════════════════════════════════
//  STYLES
// ════════════════════════════════════════════════════════════
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F0F0F' },
  content:   { paddingHorizontal: 20, paddingTop: 64, paddingBottom: 20 },

  header:       { marginBottom: 28 },
  headerTitle:  { fontSize: 28, fontWeight: '900', color: '#FFFFFF', letterSpacing: -1 },
  headerSub:    { fontSize: 13, color: '#4B5563', marginTop: 4 },

  sectionLabel: {
    fontSize: 11, fontWeight: '700', color: '#6B7280',
    textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 12,
  },
  hint: { fontSize: 12, color: '#4B5563', marginBottom: 20, lineHeight: 18 },

  chip: {
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 20, borderWidth: 1, borderColor: '#2D2D2D', backgroundColor: '#161616',
  },
  chipActive:      { borderColor: '#10B981', backgroundColor: '#10B98115' },
  chipLabel:       { fontSize: 13, color: '#6B7280', fontWeight: '500' },
  chipLabelActive: { color: '#10B981', fontWeight: '700' },

  grossDisplayCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#161616', borderRadius: 12,
    borderWidth: 1.5, borderColor: '#2D2D2D',
    paddingHorizontal: 16, paddingVertical: 14, marginBottom: 8,
  },
  grossDisplayLabel: { fontSize: 13, color: '#9CA3AF', fontWeight: '600', marginBottom: 2 },
  grossDisplaySub:   { fontSize: 11, color: '#4B5563' },
  grossDisplayAmount:{ fontSize: 28, fontWeight: '900', color: '#10B981' },

  // ── NEW: personalisation banners ──
  personalBanner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: '#071A12', borderRadius: 10, borderWidth: 1, borderColor: '#10B98130',
    padding: 12, marginBottom: 4,
  },
  personalBannerIcon:  { fontSize: 18 },
  personalBannerTitle: { fontSize: 13, fontWeight: '700', color: '#10B981', marginBottom: 2 },
  personalBannerBody:  { fontSize: 12, color: '#4B5563', lineHeight: 17 },

  estimateBanner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: '#1A1200', borderRadius: 10, borderWidth: 1, borderColor: '#F59E0B20',
    padding: 12, marginBottom: 4,
  },
  estimateBannerIcon:  { fontSize: 18 },
  estimateBannerTitle: { fontSize: 13, fontWeight: '700', color: '#F59E0B', marginBottom: 2 },
  estimateBannerBody:  { fontSize: 12, color: '#4B5563', lineHeight: 17 },

  detectingRow:  { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  detectingText: { fontSize: 13, color: '#6B7280' },
  screenTimeNotice: {
    backgroundColor: '#0A2E23', borderRadius: 8, borderWidth: 1, borderColor: '#10B98130',
    paddingHorizontal: 12, paddingVertical: 8, marginBottom: 12,
  },
  screenTimeNoticeText: { fontSize: 12, color: '#10B981' },

  slotGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 8 },
  slotCard: {
    width: '47.5%', backgroundColor: '#161616', borderRadius: 12,
    borderWidth: 1.5, borderColor: '#2D2D2D', padding: 14,
  },
  slotCardActive: { borderColor: '#10B98160', backgroundColor: '#10B98108' },
  slotTop:       { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  slotIcon:      { fontSize: 22 },
  slotActiveBadge: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: '#10B981', alignItems: 'center', justifyContent: 'center',
  },
  slotActiveBadgeText: { fontSize: 11, color: '#fff', fontWeight: '900' },
  slotLabel:      { fontSize: 14, fontWeight: '700', color: '#9CA3AF', marginBottom: 2 },
  slotLabelActive:{ color: '#FFFFFF' },
  slotTime:       { fontSize: 11, color: '#4B5563', marginBottom: 6 },
  slotDetected:   { fontSize: 11, color: '#10B981', marginBottom: 4 },
  // ── NEW ──
  slotEntryCount:        { fontSize: 10, marginBottom: 6, fontWeight: '600' },
  slotEntryCountReal:    { color: '#10B981' },
  slotEntryCountPending: { color: '#6B7280' },
  slotBestBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, alignSelf: 'flex-start',
  },
  slotBestDot:  { width: 5, height: 5, borderRadius: 3 },
  slotBestText: { fontSize: 10, fontWeight: '700' },

  winnerCard: {
    backgroundColor: '#0A0A0A', borderRadius: 16, borderWidth: 1.5, padding: 20, marginBottom: 24,
  },
  winnerTop:     { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  winnerBadge:   { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 5 },
  winnerBadgeText: { fontSize: 9, fontWeight: '900', color: '#fff', letterSpacing: 1 },
  platformDot:   { width: 8, height: 8, borderRadius: 4 },
  winnerPlatform:{ fontSize: 18, fontWeight: '900' },
  winnerTakeHome:{ fontSize: 36, fontWeight: '900', color: '#fff', letterSpacing: -1.5, marginBottom: 6 },
  winnerTakeHomeSub:{ fontSize: 14, fontWeight: '400', color: '#6B7280' },
  winnerReason:  { fontSize: 13, color: '#9CA3AF', lineHeight: 19, marginBottom: 14 },
  winnerSlotRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  winnerSlotChip:{
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#1A1A1A', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
  },
  winnerSlotIcon:  { fontSize: 14 },
  winnerSlotLabel: { fontSize: 12, color: '#9CA3AF', fontWeight: '500' },
  winnerSlotMult:  { fontSize: 12, fontWeight: '800' },
  winnerSlotReal:  { fontSize: 9, color: '#10B981', fontWeight: '700', marginLeft: 2 },

  compareRow:    { marginBottom: 20 },
  compareRowLeft:{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  compareLabel:  { fontSize: 14, color: '#D1D5DB', fontWeight: '600' },
  rankBadge:     { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5 },
  rankBadgeText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  compareAmount: { fontSize: 22, fontWeight: '900', letterSpacing: -0.8, marginBottom: 8 },
  compareBarTrack:{ height: 10, backgroundColor: '#1A1A1A', borderRadius: 5, overflow: 'hidden', marginBottom: 4 },
  compareBarFill:{ height: 10, borderRadius: 5 },
  compareTax:    { fontSize: 11, color: '#4B5563' },

  slotPlatformTable: {
    backgroundColor: '#161616', borderRadius: 12,
    borderWidth: 1, borderColor: '#2D2D2D', overflow: 'hidden', marginBottom: 8,
  },
  tableRow:       { flexDirection: 'row', padding: 12, borderBottomWidth: 1, borderBottomColor: '#1F2937' },
  tableHeaderRow: { backgroundColor: '#1A1A1A' },
  tableRowActive: { backgroundColor: '#10B98106' },
  tableCell:      { justifyContent: 'center' },
  tableHeaderCell:{ fontSize: 10, color: '#4B5563', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  tableSlotIcon:  { fontSize: 16, marginBottom: 2 },
  tableSlotLabel: { fontSize: 12, color: '#D1D5DB', fontWeight: '600' },
  tableSlotTime:  { fontSize: 10, color: '#4B5563' },
  tableMultiplier:{ fontSize: 13, fontWeight: '600', textAlign: 'center' },
  tableBestDot:   { width: 5, height: 5, borderRadius: 3, alignSelf: 'center', marginTop: 3 },
  tableRealBadge: { fontSize: 8, color: '#10B981', fontWeight: '700', textAlign: 'center', marginTop: 2 },
  tableDetected:  { fontSize: 9, color: '#10B981', textAlign: 'center', marginTop: 2 },

  screenTimeGrid: { flexDirection: 'row', gap: 10, marginBottom: 8 },
  screenTimeCard: {
    flex: 1, backgroundColor: '#161616', borderRadius: 12,
    borderWidth: 1, borderColor: '#2D2D2D', padding: 12, alignItems: 'center',
  },
  screenTimePlatform:  { fontSize: 11, fontWeight: '700', marginBottom: 4, textAlign: 'center' },
  screenTimeTotal:     { fontSize: 24, fontWeight: '900', color: '#fff' },
  screenTimeTotalLabel:{ fontSize: 10, color: '#4B5563', marginBottom: 8 },
  screenTimeSlotRow:   { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  screenTimeSlotIcon:  { fontSize: 12 },
  screenTimeSlotHrs:   { fontSize: 11, color: '#9CA3AF', fontWeight: '600' },

  platformCard: {
    backgroundColor: '#111', borderRadius: 16, borderWidth: 1, borderColor: '#2D2D2D', padding: 20, marginBottom: 14,
  },
  cardHeader:       { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  cardPlatformName: { fontSize: 16, fontWeight: '800', flex: 1 },
  cardBestBadge:    { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5 },
  cardBestBadgeText:{ fontSize: 9, fontWeight: '900', color: '#fff', letterSpacing: 0.8 },
  cardChevron:      { fontSize: 11, color: '#4B5563', marginLeft: 4 },
  cardTakeHome:     { fontSize: 34, fontWeight: '900', letterSpacing: -1.5, marginBottom: 4 },
  cardTakeHomeSub:  { fontSize: 11, color: '#4B5563', marginBottom: 14 },

  scoreRow:   { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  scoreLabel: { fontSize: 11, color: '#6B7280', width: 72 },
  scoreTrack: { flex: 1, height: 6, backgroundColor: '#1F2937', borderRadius: 3, overflow: 'hidden' },
  scoreFill:  { height: 6, borderRadius: 3 },
  scoreNumber:{ fontSize: 12, fontWeight: '800', width: 36, textAlign: 'right' },

  pillRow: { flexDirection: 'row', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
  pill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 7, borderWidth: 1 },
  pillText: { fontSize: 11, color: '#9CA3AF', fontWeight: '600' },

  minWageRow: { flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 8, padding: 10, marginBottom: 12 },
  minWageText:{ fontSize: 12, fontWeight: '600' },

  bestSlotRow:  { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  bestSlotIcon: { fontSize: 16 },
  bestSlotText: { fontSize: 12, color: '#6B7280', lineHeight: 18, flex: 1 },

  expanded:       { marginTop: 4 },
  expandedDivider:{ height: 1, backgroundColor: '#1F2937', marginVertical: 16 },
  expandedGrid:   { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  expandedStatCell:{
    width: '47%', backgroundColor: '#0A0A0A', borderRadius: 8,
    borderWidth: 1, borderColor: '#1F2937', padding: 12,
  },
  expandedStatLabel:{ fontSize: 10, color: '#4B5563', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  expandedStatValue:{ fontSize: 13, color: '#D1D5DB', fontWeight: '600' },

  slotEarningRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12, paddingHorizontal: 10, borderRadius: 8, marginBottom: 4,
  },
  slotEarningIcon:    { fontSize: 18 },
  slotEarningLabel:   { fontSize: 13, color: '#D1D5DB', fontWeight: '600' },
  slotEarningTime:    { fontSize: 11, color: '#4B5563' },
  slotEarningReal:    { fontSize: 11, color: '#10B981', marginTop: 2, fontWeight: '600' },
  slotEarningPending: { fontSize: 11, color: '#4B5563', marginTop: 2 },
  slotEarningDetected:{ fontSize: 11, color: '#10B981', marginTop: 2 },
  slotEarningAmount:  { fontSize: 16, fontWeight: '900' },
  slotEarningMult:    { fontSize: 10, color: '#6B7280' },

  expandedSource: { fontSize: 10, color: '#374151', marginTop: 16, lineHeight: 15 },

  insightCard: {
    backgroundColor: '#0D0D0D', borderRadius: 12, borderWidth: 1, borderColor: '#1F2937', padding: 18, marginTop: 8,
  },
  insightTitle:  { fontSize: 14, fontWeight: '800', color: '#D1D5DB', marginBottom: 10 },
  insightBody:   { fontSize: 13, color: '#6B7280', lineHeight: 20 },
  insightSource: { fontSize: 10, color: '#374151', marginTop: 10 },
})

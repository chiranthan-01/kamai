import React, { useState, useRef, useEffect } from 'react'
import * as Crypto from 'expo-crypto'
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  Animated, Platform, Switch, StyleSheet, KeyboardAvoidingView,
  ActivityIndicator, Alert, StatusBar,
} from 'react-native'
import {
  MIN_WAGE_HOURLY, CITY_LABELS,
  PLATFORM_DATA, calculateEarnings,
} from '../../constants/kamai'
import {
  readRiderEarnings,
  writeRiderEarnings,
} from '../../lib/riderStorage'
import { syncEarningReport } from '../../lib/earningReports'

// ── Android screen time: package names for each platform ──
const PLATFORM_PACKAGES: Record<string, string> = {
  zepto: 'com.zepto.delivery',
  blinkit: 'com.blinkit.partner',
  instamart: 'in.swiggy.deliveryapp',
}

async function getScreenTimeHours(packageName: string): Promise<number | null> {
  if (Platform.OS !== 'android') return null
  try {
    const UsageStats = require('@brighthustle/react-native-usage-stats-manager').default
    const endTime = Date.now()
    const startTime = endTime - 7 * 24 * 60 * 60 * 1000
    const stats = await UsageStats.queryUsageStats(startTime, endTime)
    const app = stats?.find((s: { packageName: string; totalTimeInForeground: number }) =>
      s.packageName === packageName
    )
    if (!app?.totalTimeInForeground) return null
    return Math.round((app.totalTimeInForeground / 1000 / 3600) * 10) / 10
  } catch {
    return null
  }
}

// ── Types ──
const PLATFORMS = ['zepto', 'blinkit', 'instamart'] as const
const CITIES = ['bengaluru', 'delhi', 'chennai', 'kochi', 'thiruvananthapuram'] as const
type PlatformKey = (typeof PLATFORMS)[number]
type CityKey = (typeof CITIES)[number]
type SlotKey = 'morning' | 'afternoon' | 'evening' | 'night'

// ── Time slots (same definition as platforms tab) ──
const TIME_SLOTS: {
  key: SlotKey; label: string; sublabel: string; icon: string
}[] = [
  { key: 'morning',   label: 'Morning Rush', sublabel: '7 AM – 11 AM', icon: '🌅' },
  { key: 'afternoon', label: 'Afternoon',    sublabel: '11 AM – 4 PM', icon: '☀️' },
  { key: 'evening',   label: 'Evening Rush', sublabel: '4 PM – 9 PM',  icon: '🌆' },
  { key: 'night',     label: 'Late Night',   sublabel: '9 PM – 2 AM',  icon: '🌙' },
]

const BAR_COLORS = {
  commission: '#EF4444',
  gst: '#DC2626',
  tds: '#B91C1C',
  appFee: '#F59E0B',
  fuel: '#D97706',
}

const fmt = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

// ════════════════════════════════════════════════════════════
//  MAIN SCREEN
// ════════════════════════════════════════════════════════════
export default function CalculatorScreen() {
  const [platform, setPlatform] = useState<PlatformKey>('zepto')
  const [city, setCity] = useState<CityKey>('bengaluru')
  const [grossInput, setGrossInput] = useState('')
  const [ordersInput, setOrdersInput] = useState('')
  const [bonusEnabled, setBonusEnabled] = useState(false)
  const [bonusInput, setBonusInput] = useState('')
  const [fuelEnabled, setFuelEnabled] = useState(false)
  const [fuelInput, setFuelInput] = useState('')
  const [hours, setHours] = useState(40)
  const [hoursDetected, setHoursDetected] = useState<number | null>(null)
  const [hoursConfirmed, setHoursConfirmed] = useState(false)
  const [loadingScreenTime, setLoadingScreenTime] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedOk, setSavedOk] = useState(false)
  const [calculationRecordId, setCalculationRecordId] = useState<string | null>(null)
  const [results, setResults] = useState<ReturnType<typeof calculateEarnings> | null>(null)

  // ── NEW: which slots did you work this session ──
  const [activeSlots, setActiveSlots] = useState<Set<SlotKey>>(new Set())

  const fadeIn = useRef(new Animated.Value(0)).current
  const barCommission = useRef(new Animated.Value(0)).current
  const barGst = useRef(new Animated.Value(0)).current
  const barTds = useRef(new Animated.Value(0)).current
  const barAppFee = useRef(new Animated.Value(0)).current
  const barFuel = useRef(new Animated.Value(0)).current
  const heroScale = useRef(new Animated.Value(0.85)).current
  const heroOpacity = useRef(new Animated.Value(0)).current

  const platformInfo = PLATFORM_DATA[platform]
  const commissionPct = (platformInfo.commissionMin + platformInfo.commissionMax) / 2
  const appFee = (platformInfo.appFeeMin + platformInfo.appFeeMax) / 2

  useEffect(() => {
    setHoursDetected(null)
    setHoursConfirmed(false)
    setShowResults(false)
    if (Platform.OS === 'android') {
      setLoadingScreenTime(true)
      getScreenTimeHours(PLATFORM_PACKAGES[platform]).then(h => {
        setLoadingScreenTime(false)
        if (h !== null) {
          setHoursDetected(h)
          setHours(h)
        }
      })
    }
  }, [platform])

  // ── Calculate ──
  const handleCalculate = () => {
    const gross = parseFloat(grossInput)
    const orders = parseInt(ordersInput, 10) || 0
    if (!gross || gross <= 0) {
      Alert.alert('Enter your earnings', `Type the amount ${platformInfo.label} shows in your partner app.`)
      return
    }
    if (orders <= 0) {
      Alert.alert('Enter orders served', 'How many orders did you complete this week?')
      return
    }
    const bonus = bonusEnabled ? parseFloat(bonusInput) || 0 : 0
    const fuel = fuelEnabled ? parseFloat(fuelInput) || 0 : 0
    const quarterlyGross = gross * 13

    const calc = calculateEarnings({
      gross,
      bonus,
      commissionPct,
      appFee,
      fuel,
      hours,
      orders,
      hasPan: true,
      quarterlyGross,
    })
    setResults(calc)
    setShowResults(true)
    setCalculationRecordId(Crypto.randomUUID())
    setSavedOk(false)

    ;[barCommission, barGst, barTds, barAppFee, barFuel, fadeIn, heroOpacity].forEach(v =>
      v.setValue(0)
    )
    heroScale.setValue(0.85)

    Animated.sequence([
      Animated.timing(fadeIn, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.stagger(180, [
        Animated.timing(barCommission, { toValue: 1, duration: 450, useNativeDriver: false }),
        Animated.timing(barGst, { toValue: 1, duration: 450, useNativeDriver: false }),
        ...(calc.tdsApplies
          ? [Animated.timing(barTds, { toValue: 1, duration: 450, useNativeDriver: false })]
          : []),
        Animated.timing(barAppFee, { toValue: 1, duration: 450, useNativeDriver: false }),
        ...(fuelEnabled
          ? [Animated.timing(barFuel, { toValue: 1, duration: 450, useNativeDriver: false })]
          : []),
      ]),
      Animated.parallel([
        Animated.spring(heroScale, { toValue: 1, tension: 80, friction: 8, useNativeDriver: true }),
        Animated.timing(heroOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      ]),
    ]).start()
  }

  // ── Toggle a slot on/off ──
  const toggleSlot = (slot: SlotKey) => {
    setActiveSlots(prev => {
      const next = new Set(prev)
      if (next.has(slot)) next.delete(slot)
      else next.add(slot)
      return next
    })
  }

  // ── Save to the authenticated rider's profile history ──
  const handleSave = async () => {
    if (!results || !grossInput || !calculationRecordId || saving || savedOk) return
    const gross = parseFloat(grossInput)
    const orders = parseInt(ordersInput, 10) || 0
    const bonus = bonusEnabled ? parseFloat(bonusInput) || 0 : 0
    const fuel = fuelEnabled ? parseFloat(fuelInput) || 0 : 0
    const quarterlyGross = gross * 13

    // Build week_start (Monday of current week)
    const d = new Date()
    const day = d.getDay()
    const diff = d.getDate() - day + (day === 0 ? -6 : 1)
    d.setDate(diff)
    const weekStart = d.toISOString().split('T')[0]

    const entry = {
      id: calculationRecordId,
      platform,
      week_start: weekStart,
      gross,
      orders,
      hours,
      bonus,
      app_fee: appFee,
      fuel,
      commission_pct: commissionPct,
      has_pan: true,
      quarterly_gross: quarterlyGross,
      // ── NEW: store which slots rider worked this session ──
      slots: Array.from(activeSlots), // e.g. ['morning', 'evening']
      // Computed fields stored for instant expand view in Rider Profile
      commission: results.commission,
      gst_on_commission: results.gstOnCommission,
      tds: results.tds,
      tds_applies: results.tdsApplies,
      net_from_platform: results.netFromPlatform,
      true_take_home: results.trueTakeHome,
      effective_rate: results.effectiveHourlyRate,
      per_order: results.perOrder,
      platform_tax_rate: results.platformTaxRate,
      annual_projection: results.annualProjection,
      synced: false,
      created_at: new Date().toISOString(),
    }

    setSaving(true)
    try {
      // Save only inside the authenticated rider's local storage namespace.
      const arr = await readRiderEarnings<typeof entry>()
      const updated = [entry, ...arr]
      await writeRiderEarnings(updated)

      // Sync the authenticated report. The client UUID makes retries idempotent.
      try {
        await syncEarningReport({
          clientRecordId: entry.id,
          platform,
          periodStart: weekStart,
          hours,
          orders,
          gross,
          bonus,
          commission: results.commission,
          gstOnCommission: results.gstOnCommission,
          tds: results.tds,
          platformFees: appFee,
          fuelCost: fuel,
          workSlots: Array.from(activeSlots),
          hasPan: true,
          quarterlyGross,
        })
        // Mark synced
        const synced = updated.map((e: typeof entry) =>
          e.id === entry.id ? { ...e, synced: true } : e
        )
        await writeRiderEarnings(synced)
      } catch {
        // Network unavailable — local save is sufficient
      }

      setSavedOk(true)
    } finally {
      setSaving(false)
    }
  }

  const pctOfGross = (amount: number) => {
    const gross = parseFloat(grossInput) || 1
    return Math.max(3, Math.min(100, (amount / gross) * 100))
  }
  const minWage = MIN_WAGE_HOURLY[city]
  const aboveMinWage = results ? results.effectiveHourlyRate >= minWage : false

  // ════════════════════════════════════════════════════════════
  //  RENDER
  // ════════════════════════════════════════════════════════════
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <StatusBar barStyle="light-content" backgroundColor="#0F0F0F" />

        {/* ── Header ── */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>kamai</Text>
          <Text style={styles.headerTagline}>har order ka hisaab</Text>
        </View>

        {/* ── Platform selector ── */}
        <Text style={styles.sectionLabel}>Your platform</Text>
        <View style={styles.platformRow}>
          {PLATFORMS.map(p => {
            const pd = PLATFORM_DATA[p]
            const active = platform === p
            return (
              <TouchableOpacity
                key={p}
                style={[
                  styles.platformBtn,
                  active && { borderColor: pd.color, backgroundColor: pd.color + '1A' },
                ]}
                onPress={() => setPlatform(p)}
                activeOpacity={0.75}
              >
                <View style={[styles.platformDot, { backgroundColor: pd.color }]} />
                <Text style={[styles.platformBtnLabel, active && { color: pd.color }]}>
                  {p === 'instamart' ? 'Instamart' : pd.label}
                </Text>
              </TouchableOpacity>
            )
          })}
        </View>

        {/* ── City selector ── */}
        <Text style={styles.sectionLabel}>Your city</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.cityScroll}
          contentContainerStyle={{ gap: 8 }}
        >
          {CITIES.map(c => (
            <TouchableOpacity
              key={c}
              style={[styles.cityChip, city === c && styles.cityChipActive]}
              onPress={() => { setCity(c); setShowResults(false) }}
              activeOpacity={0.75}
            >
              <Text style={[styles.cityChipLabel, city === c && styles.cityChipLabelActive]}>
                {CITY_LABELS[c]}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* ── Gross earnings input ── */}
        <Text style={styles.sectionLabel}>
          What did {platformInfo.label} say you earned this week?
        </Text>
        <View style={styles.inputBox}>
          <Text style={[styles.rupeeSign, { color: platformInfo.color }]}>₹</Text>
          <TextInput
            style={styles.grossInput}
            value={grossInput}
            onChangeText={t => {
              setGrossInput(t.replace(/[^0-9.]/g, ''))
              setShowResults(false)
            }}
            placeholder="e.g. 4500"
            placeholderTextColor="#4B5563"
            keyboardType="numeric"
            returnKeyType="next"
          />
        </View>
        <Text style={styles.hint}>
          The number shown in your {platformInfo.label} partner app — before any deductions.
        </Text>

        {/* ── Orders served ── */}
        <Text style={styles.sectionLabel}>Orders completed this week</Text>
        <View style={styles.inputBox}>
          <Text style={[styles.rupeeSign, { color: platformInfo.color, fontSize: 18 }]}>#</Text>
          <TextInput
            style={styles.grossInput}
            value={ordersInput}
            onChangeText={t => {
              setOrdersInput(t.replace(/[^0-9]/g, ''))
              setShowResults(false)
            }}
            placeholder="e.g. 68"
            placeholderTextColor="#4B5563"
            keyboardType="numeric"
            returnKeyType="next"
          />
        </View>
        <Text style={styles.hint}>
          Check your {platformInfo.label} partner app for total orders this week.
        </Text>

        {/* ── Hours worked ── */}
        <Text style={styles.sectionLabel}>Hours worked this week</Text>

        {Platform.OS === 'android' ? (
          <View style={styles.card}>
            {loadingScreenTime ? (
              <View style={styles.row}>
                <ActivityIndicator color="#10B981" size="small" />
                <Text style={[styles.hint, { marginLeft: 10, marginBottom: 0 }]}>
                  Reading your screen time…
                </Text>
              </View>
            ) : hoursDetected !== null && !hoursConfirmed ? (
              <View>
                <Text style={styles.detectedHours}>
                  📱 {hoursDetected} hrs on {platformInfo.label} this week
                </Text>
                <Text style={[styles.hint, { marginTop: 4, marginBottom: 12 }]}>
                  Includes waiting time between orders. Fairwork India 2024 counts this as work time.
                </Text>
                <View style={[styles.row, { gap: 10 }]}>
                  <TouchableOpacity
                    style={[styles.confirmBtn, { backgroundColor: platformInfo.color }]}
                    onPress={() => setHoursConfirmed(true)}
                  >
                    <Text style={styles.confirmBtnText}>✓ Use this</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.editBtn}
                    onPress={() => {
                      setHoursConfirmed(true)
                      setHoursDetected(null)
                    }}
                  >
                    <Text style={styles.editBtnText}>Edit manually</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <HoursStepper
                hours={hours}
                onChange={h => { setHours(h); setShowResults(false) }}
              />
            )}
          </View>
        ) : (
          <HoursStepper
            hours={hours}
            onChange={h => { setHours(h); setShowResults(false) }}
          />
        )}

        {/* ── Bonus / Surge toggle ── */}
        <View style={styles.fuelToggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.sectionLabel}>Bonus / Surge received</Text>
            <Text style={[styles.hint, { marginBottom: 0 }]}>
              Any extra incentive or surge pay this week
            </Text>
          </View>
          <Switch
            value={bonusEnabled}
            onValueChange={v => { setBonusEnabled(v); setShowResults(false) }}
            trackColor={{ false: '#374151', true: '#10B98150' }}
            thumbColor={bonusEnabled ? '#10B981' : '#6B7280'}
          />
        </View>

        {bonusEnabled && (
          <View style={[styles.inputBox, { marginTop: 10, marginBottom: 8 }]}>
            <Text style={[styles.rupeeSign, { color: '#10B981' }]}>₹</Text>
            <TextInput
              style={styles.grossInput}
              value={bonusInput}
              onChangeText={t => { setBonusInput(t.replace(/[^0-9.]/g, '')); setShowResults(false) }}
              placeholder="Bonus / surge amount this week"
              placeholderTextColor="#4B5563"
              keyboardType="numeric"
              returnKeyType="next"
            />
          </View>
        )}
        {bonusEnabled && (
          <Text style={styles.hint}>
            Included in your gross for accurate take-home calculation.
          </Text>
        )}

        {/* ── Fuel toggle ── */}
        <View style={styles.fuelToggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.sectionLabel}>Include fuel cost</Text>
            <Text style={[styles.hint, { marginBottom: 0 }]}>Your petrol spend this week</Text>
          </View>
          <Switch
            value={fuelEnabled}
            onValueChange={v => { setFuelEnabled(v); setShowResults(false) }}
            trackColor={{ false: '#374151', true: '#10B98150' }}
            thumbColor={fuelEnabled ? '#10B981' : '#6B7280'}
          />
        </View>

        {fuelEnabled && (
          <View style={[styles.inputBox, { marginTop: 10 }]}>
            <Text style={[styles.rupeeSign, { color: '#D97706' }]}>₹</Text>
            <TextInput
              style={styles.grossInput}
              value={fuelInput}
              onChangeText={t => { setFuelInput(t.replace(/[^0-9.]/g, '')); setShowResults(false) }}
              placeholder="Weekly fuel spend"
              placeholderTextColor="#4B5563"
              keyboardType="numeric"
              returnKeyType="done"
            />
          </View>
        )}

        {/* ── Auto-calculated disclosure ── */}
        <View style={styles.autoCard}>
          <Text style={styles.autoCardTitle}>Filled from verified data</Text>
          <AutoRow label={`Commission (${platformInfo.label} avg)`} value={`${commissionPct.toFixed(1)}%`} />
          <AutoRow label="GST on commission" value="18% (CBDT law)" />
          <AutoRow label="Weekly app fee" value={`₹${Math.round(appFee)}`} />
          <AutoRow label="TDS" value="1% if >₹30k/quarter" />
          <Text style={styles.autoCardSource}>
            Sources: Platform partner pages · CBDT · Income Tax Act §194C · Fairwork India 2024
          </Text>
        </View>

        {/* ── CTA ── */}
        <TouchableOpacity
          style={[styles.cta, { backgroundColor: platformInfo.color }]}
          onPress={handleCalculate}
          activeOpacity={0.85}
        >
          <Text style={styles.ctaText}>Show me where my money went →</Text>
        </TouchableOpacity>

        {/* ════════════════ RESULTS ════════════════ */}
        {showResults && results && (
          <Animated.View style={{ opacity: fadeIn }}>
            <Text style={[styles.sectionLabel, { marginTop: 32 }]}>Where it went</Text>

            <DeductionBar
              label={`Platform commission (${commissionPct.toFixed(1)}%)`}
              amount={results.commission}
              pct={pctOfGross(results.commission)}
              animValue={barCommission}
              color={BAR_COLORS.commission}
            />
            <DeductionBar
              label="GST on commission"
              amount={results.gstOnCommission}
              pct={pctOfGross(results.gstOnCommission)}
              animValue={barGst}
              color={BAR_COLORS.gst}
            />
            {results.tdsApplies && (
              <DeductionBar
                label="TDS (1% — income >₹30k/quarter)"
                amount={results.tds}
                pct={pctOfGross(results.tds)}
                animValue={barTds}
                color={BAR_COLORS.tds}
              />
            )}
            <DeductionBar
              label={`App fee (₹${Math.round(appFee)}/week)`}
              amount={results.appFee}
              pct={pctOfGross(results.appFee)}
              animValue={barAppFee}
              color={BAR_COLORS.appFee}
            />
            {fuelEnabled && results.fuel > 0 && (
              <DeductionBar
                label="Fuel (your operating cost)"
                amount={results.fuel}
                pct={pctOfGross(results.fuel)}
                animValue={barFuel}
                color={BAR_COLORS.fuel}
              />
            )}

            {/* ── Hero take-home ── */}
            <Animated.View
              style={[
                styles.heroCard,
                { opacity: heroOpacity, transform: [{ scale: heroScale }] },
              ]}
            >
              <Text style={styles.heroLabel}>Your true take-home</Text>
              <Text style={styles.heroAmount}>{fmt(results.trueTakeHome)}</Text>
              <Text style={styles.heroSub}>
                Platform kept{' '}
                {fmt(
                  results.totalGross - results.trueTakeHome - (fuelEnabled ? results.fuel : 0)
                )}{' '}
                in taxes + fees
              </Text>
              {bonusEnabled && results.totalGross > parseFloat(grossInput || '0') && (
                <Text style={[styles.heroSub, { color: '#10B981', marginTop: 4 }]}>
                  Includes {fmt(parseFloat(bonusInput) || 0)} bonus / surge
                </Text>
              )}
            </Animated.View>

            {/* ── Stats row ── */}
            <View style={styles.statsRow}>
              <StatCard label="Per order" value={fmt(results.perOrder)} />
              <StatCard label="Per hour" value={fmt(results.effectiveHourlyRate)} />
              <StatCard
                label="Platform takes"
                value={`${results.platformTaxRate.toFixed(1)}%`}
              />
            </View>

            {/* Orders + Annual row */}
            <View style={[styles.statsRow, { marginTop: -4 }]}>
              <StatCard label="Orders done" value={`${parseInt(ordersInput) || 0}`} />
              <StatCard label="Annual ×52" value={fmt(results.annualProjection)} />
            </View>

            {/* ── Minimum wage verdict ── */}
            <View
              style={[
                styles.verdictCard,
                {
                  borderColor: aboveMinWage ? '#10B981' : '#EF4444',
                  backgroundColor: aboveMinWage ? '#10B98110' : '#EF444410',
                },
              ]}
            >
              <Text style={styles.verdictIcon}>{aboveMinWage ? '✅' : '⚠️'}</Text>
              <View style={{ flex: 1 }}>
                <Text
                  style={[
                    styles.verdictTitle,
                    { color: aboveMinWage ? '#10B981' : '#EF4444' },
                  ]}
                >
                  {aboveMinWage ? 'Above minimum wage' : 'Below minimum wage'}
                </Text>
                <Text style={styles.verdictBody}>
                  Your rate: {fmt(results.effectiveHourlyRate)}/hr.{' '}
                  {CITY_LABELS[city]} minimum: ₹{minWage}/hr.
                </Text>
                {!aboveMinWage && (
                  <Text style={styles.verdictBody}>
                    You are earning ₹{(minWage - results.effectiveHourlyRate).toFixed(0)} less
                    per hour than the government minimum wage.
                  </Text>
                )}
                <Text style={styles.verdictSource}>
                  Fairwork India 2024 · Appendix II · State Labour Dept notifications
                </Text>
              </View>
            </View>

            {/* ── TDS alert ── */}
            {results.tdsApplies && (
              <View style={styles.tdsAlert}>
                <Text style={styles.tdsAlertText}>
                  💡 TDS was deducted this quarter. File ITR-1 to reclaim{' '}
                  {fmt(results.tds)} if your total income is below the taxable limit (₹2.5L/year).
                </Text>
              </View>
            )}

            {/* ── NEW: When did you work this week? ── */}
            <View style={styles.slotSection}>
              <Text style={styles.slotSectionTitle}>When did you work this week?</Text>
              <Text style={styles.slotSectionSub}>
                Select the slots you worked — saved with your entry to personalise the Platforms tab over time
              </Text>
              <View style={styles.slotGrid}>
                {TIME_SLOTS.map(slot => {
                  const active = activeSlots.has(slot.key)
                  return (
                    <TouchableOpacity
                      key={slot.key}
                      style={[styles.slotChip, active && styles.slotChipActive]}
                      onPress={() => toggleSlot(slot.key)}
                      activeOpacity={0.75}
                    >
                      <Text style={styles.slotChipIcon}>{slot.icon}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.slotChipLabel, active && styles.slotChipLabelActive]}>
                          {slot.label}
                        </Text>
                        <Text style={styles.slotChipTime}>{slot.sublabel}</Text>
                      </View>
                      {active && (
                        <View style={styles.slotChipCheck}>
                          <Text style={styles.slotChipCheckText}>✓</Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  )
                })}
              </View>
              {activeSlots.size === 0 && (
                <Text style={styles.slotSkipHint}>
                  Optional — skip if you don't want to track this
                </Text>
              )}
            </View>

            {/* ── Save button ── */}
            <TouchableOpacity
              style={[styles.saveBtn, (saving || savedOk) && { opacity: 0.6 }]}
              onPress={handleSave}
              disabled={saving || savedOk}
              activeOpacity={0.8}
            >
              {saving ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : savedOk ? (
                <Text style={styles.saveBtnText}>✓ Saved to Rider Profile</Text>
              ) : (
                <Text style={styles.saveBtnText}>Save to Rider Profile →</Text>
              )}
            </TouchableOpacity>

            <Text style={styles.sourceFooter}>
              Fairwork India 2024 · NITI Aayog 2022 · CBDT · Income Tax Act §194C
            </Text>
          </Animated.View>
        )}

        <View style={{ height: 80 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

// ════════════════════════════════════════════════════════════
//  SUB-COMPONENTS
// ════════════════════════════════════════════════════════════

function HoursStepper({ hours, onChange }: { hours: number; onChange: (h: number) => void }) {
  return (
    <View style={styles.stepperCard}>
      <TouchableOpacity
        style={styles.stepperBtn}
        onPress={() => onChange(Math.max(0, +(hours - 0.5).toFixed(1)))}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Text style={styles.stepperBtnText}>−</Text>
      </TouchableOpacity>
      <View style={{ alignItems: 'center' }}>
        <Text style={styles.stepperValue}>{hours}</Text>
        <Text style={styles.stepperUnit}>hrs / week</Text>
      </View>
      <TouchableOpacity
        style={styles.stepperBtn}
        onPress={() => onChange(Math.min(100, +(hours + 0.5).toFixed(1)))}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Text style={styles.stepperBtnText}>+</Text>
      </TouchableOpacity>
    </View>
  )
}

function DeductionBar({
  label, amount, pct, animValue, color,
}: {
  label: string; amount: number; pct: number; animValue: Animated.Value; color: string
}) {
  const width = animValue.interpolate({ inputRange: [0, 1], outputRange: ['0%', `${pct}%`] })
  return (
    <View style={styles.barWrap}>
      <View style={styles.barHeader}>
        <Text style={styles.barLabel}>{label}</Text>
        <Text style={[styles.barAmount, { color }]}>{fmt(amount)}</Text>
      </View>
      <View style={styles.barTrack}>
        <Animated.View style={[styles.barFill, { width, backgroundColor: color }]} />
      </View>
    </View>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  )
}

function AutoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.autoRow}>
      <Text style={styles.autoRowLabel}>{label}</Text>
      <Text style={styles.autoRowValue}>{value}</Text>
    </View>
  )
}

// ════════════════════════════════════════════════════════════
//  STYLES
// ════════════════════════════════════════════════════════════
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F0F0F' },
  content: { paddingHorizontal: 20, paddingTop: 64, paddingBottom: 20 },

  header: { marginBottom: 32 },
  headerTitle: {
    fontSize: 32, fontWeight: '900', color: '#10B981',
    letterSpacing: -1.5, textTransform: 'lowercase',
  },
  headerTagline: { fontSize: 13, color: '#4B5563', marginTop: 3, letterSpacing: 0.3 },

  sectionLabel: {
    fontSize: 11, fontWeight: '700', color: '#6B7280',
    textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 12,
  },

  platformRow: { flexDirection: 'row', gap: 8, marginBottom: 24 },
  platformBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 11, paddingHorizontal: 6,
    borderRadius: 10, borderWidth: 1.5, borderColor: '#2D2D2D',
    backgroundColor: '#161616', gap: 6,
  },
  platformDot: { width: 7, height: 7, borderRadius: 4 },
  platformBtnLabel: { fontSize: 12, fontWeight: '600', color: '#6B7280' },

  cityScroll: { marginBottom: 24 },
  cityChip: {
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 20, borderWidth: 1, borderColor: '#2D2D2D', backgroundColor: '#161616',
  },
  cityChipActive: { borderColor: '#10B981', backgroundColor: '#10B98115' },
  cityChipLabel: { fontSize: 13, color: '#6B7280', fontWeight: '500' },
  cityChipLabelActive: { color: '#10B981', fontWeight: '700' },

  inputBox: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#161616', borderRadius: 12,
    borderWidth: 1.5, borderColor: '#2D2D2D',
    paddingHorizontal: 16, marginBottom: 8,
  },
  rupeeSign: { fontSize: 24, fontWeight: '800', marginRight: 8 },
  grossInput: { flex: 1, fontSize: 30, color: '#FFFFFF', fontWeight: '800', paddingVertical: 16 },
  hint: { fontSize: 12, color: '#4B5563', marginBottom: 24, lineHeight: 18 },

  row: { flexDirection: 'row', alignItems: 'center' },

  card: {
    backgroundColor: '#161616', borderRadius: 12,
    borderWidth: 1, borderColor: '#2D2D2D', padding: 16, marginBottom: 24,
  },

  detectedHours: { fontSize: 16, color: '#FFFFFF', fontWeight: '700' },
  confirmBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  confirmBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  editBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8, backgroundColor: '#1F2937' },
  editBtnText: { color: '#9CA3AF', fontWeight: '600', fontSize: 14 },

  stepperCard: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#161616', borderRadius: 12, borderWidth: 1, borderColor: '#2D2D2D',
    padding: 16, marginBottom: 24,
  },
  stepperBtn: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: '#2D2D2D', alignItems: 'center', justifyContent: 'center',
  },
  stepperBtnText: { fontSize: 24, color: '#fff', fontWeight: '700', lineHeight: 28 },
  stepperValue: { fontSize: 36, fontWeight: '900', color: '#fff' },
  stepperUnit: { fontSize: 12, color: '#6B7280', marginTop: 2 },

  fuelToggleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },

  autoCard: {
    backgroundColor: '#0D1117', borderRadius: 12, borderWidth: 1, borderColor: '#1F2937',
    padding: 16, marginBottom: 24, marginTop: 16,
  },
  autoCardTitle: {
    fontSize: 11, fontWeight: '700', color: '#374151',
    textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14,
  },
  autoRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  autoRowLabel: { fontSize: 13, color: '#6B7280' },
  autoRowValue: { fontSize: 13, color: '#9CA3AF', fontWeight: '600' },
  autoCardSource: { fontSize: 10, color: '#374151', marginTop: 8, lineHeight: 15 },

  cta: { paddingVertical: 17, borderRadius: 14, alignItems: 'center', marginBottom: 8 },
  ctaText: { fontSize: 17, fontWeight: '800', color: '#fff', letterSpacing: -0.3 },

  barWrap: { marginBottom: 18 },
  barHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 7 },
  barLabel: { fontSize: 13, color: '#9CA3AF', flex: 1, marginRight: 8 },
  barAmount: { fontSize: 13, fontWeight: '700' },
  barTrack: { height: 9, backgroundColor: '#1A1A1A', borderRadius: 5, overflow: 'hidden' },
  barFill: { height: 9, borderRadius: 5 },

  heroCard: {
    backgroundColor: '#071A12', borderRadius: 16, borderWidth: 1.5, borderColor: '#10B981',
    padding: 28, alignItems: 'center', marginVertical: 24,
  },
  heroLabel: {
    fontSize: 11, color: '#10B981', fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 10,
  },
  heroAmount: { fontSize: 52, fontWeight: '900', color: '#10B981', letterSpacing: -2.5 },
  heroSub: { fontSize: 13, color: '#6B7280', marginTop: 10, textAlign: 'center' },

  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  statCard: {
    flex: 1, backgroundColor: '#161616', borderRadius: 10, padding: 14, alignItems: 'center',
    borderWidth: 1, borderColor: '#2D2D2D',
  },
  statValue: { fontSize: 16, fontWeight: '900', color: '#fff', marginBottom: 4 },
  statLabel: { fontSize: 11, color: '#6B7280', textAlign: 'center' },

  verdictCard: {
    flexDirection: 'row', alignItems: 'flex-start',
    borderRadius: 12, borderWidth: 1.5, padding: 16, marginBottom: 16, gap: 12,
    marginTop: 8,
  },
  verdictIcon: { fontSize: 22 },
  verdictTitle: { fontSize: 15, fontWeight: '800', marginBottom: 5 },
  verdictBody: { fontSize: 13, color: '#D1D5DB', lineHeight: 20, marginBottom: 4 },
  verdictSource: { fontSize: 10, color: '#6B7280', marginTop: 4 },

  tdsAlert: {
    backgroundColor: '#1A1200', borderRadius: 10, borderWidth: 1, borderColor: '#F59E0B30',
    padding: 14, marginBottom: 20,
  },
  tdsAlertText: { fontSize: 13, color: '#FCD34D', lineHeight: 20 },

  // ── NEW: slot picker styles ──
  slotSection: {
    backgroundColor: '#111',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1F2937',
    padding: 16,
    marginBottom: 20,
  },
  slotSectionTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#fff',
    marginBottom: 4,
  },
  slotSectionSub: {
    fontSize: 12,
    color: '#4B5563',
    lineHeight: 17,
    marginBottom: 14,
  },
  slotGrid: {
    gap: 8,
  },
  slotChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#161616',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2D2D2D',
    padding: 12,
  },
  slotChipActive: {
    borderColor: '#10B98160',
    backgroundColor: '#10B98110',
  },
  slotChipIcon: { fontSize: 20 },
  slotChipLabel: { fontSize: 13, fontWeight: '600', color: '#9CA3AF' },
  slotChipLabelActive: { color: '#fff' },
  slotChipTime: { fontSize: 11, color: '#4B5563', marginTop: 1 },
  slotChipCheck: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: '#10B981',
    alignItems: 'center', justifyContent: 'center',
    marginLeft: 'auto',
  },
  slotChipCheckText: { fontSize: 11, color: '#fff', fontWeight: '900' },
  slotSkipHint: {
    fontSize: 11,
    color: '#374151',
    textAlign: 'center',
    marginTop: 10,
  },

  saveBtn: {
    backgroundColor: '#10B981', paddingVertical: 16,
    borderRadius: 12, alignItems: 'center', marginBottom: 20,
  },
  saveBtnText: { fontSize: 16, fontWeight: '700', color: '#fff' },

  sourceFooter: {
    fontSize: 10, color: '#2D2D2D', textAlign: 'center', lineHeight: 16, marginBottom: 8,
  },
})

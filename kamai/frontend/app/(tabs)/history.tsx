import React, { useState, useCallback } from 'react'
import * as Crypto from 'expo-crypto'
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  RefreshControl,
  StyleSheet,
  Switch,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Share,
  Alert,
  ActivityIndicator,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import {
  PLATFORM_DATA,
  MIN_WAGE_HOURLY,
  calculateEarnings,
} from '../../constants/kamai'
import { supabase } from '../../lib/supabase'
import {
  claimLegacyEarnings,
  getLegacyEarningsCount,
  readRiderEarnings,
  writeRiderEarnings,
} from '../../lib/riderStorage'
import { fetchEarningReports, syncEarningReport } from '../../lib/earningReports'

// ─── Types ───────────────────────────────────────────────────────────────────

type PlatformKey = 'zepto' | 'blinkit' | 'instamart'
type SlotKey = 'morning' | 'afternoon' | 'evening' | 'night'

interface EarningsEntry {
  id: string
  platform: PlatformKey
  week_start: string
  gross: number
  orders: number
  hours: number
  bonus: number
  app_fee: number
  fuel: number
  commission_pct: number
  has_pan: boolean
  quarterly_gross: number
  commission: number
  gst_on_commission: number
  tds: number
  tds_applies: boolean
  net_from_platform: number
  true_take_home: number
  effective_rate: number
  per_order: number
  platform_tax_rate: number
  annual_projection: number
  synced: boolean
  created_at: string
  slots?: SlotKey[]
}

interface FormState {
  platform: PlatformKey
  week_start: string
  gross: string
  orders: string
  hours: string
  bonus: string
  app_fee: string
  fuel: string
  commission_pct: string
  has_pan: boolean
  quarterly_gross: string
}

interface KamaiUser {
  id: string
  email?: string
  city: string
  created_at: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CITY = 'bengaluru'
const MIN_WAGE = MIN_WAGE_HOURLY[DEFAULT_CITY]

const CITY_LABELS: Record<string, string> = {
  bengaluru: 'Bengaluru',
  delhi: 'Delhi',
  chennai: 'Chennai',
  kochi: 'Kochi',
  thiruvananthapuram: 'Thiruvananthapuram',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getThisMonday(): string {
  const d = new Date()
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  return d.toISOString().split('T')[0]
}

function formatINR(n: number): string {
  return '₹' + Math.round(n).toLocaleString('en-IN')
}

function formatWeek(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  const end = new Date(d)
  end.setDate(end.getDate() + 6)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d.getDate()} ${months[d.getMonth()]} – ${end.getDate()} ${months[end.getMonth()]}`
}

function formatJoinDate(dateStr: string): string {
  const d = new Date(dateStr)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `Joined ${months[d.getMonth()]} ${d.getFullYear()}`
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function BreakdownRow({
  label, val, bold = false, valColor,
}: {
  label: string; val: string; bold?: boolean; valColor?: string
}) {
  return (
    <View style={s.bdRow}>
      <Text style={[s.bdLabel, bold && s.bdLabelBold]}>{label}</Text>
      <Text style={[s.bdVal, bold && s.bdValBold, valColor ? { color: valColor } : {}]}>
        {val}
      </Text>
    </View>
  )
}

function TaxRow({
  label, val, bold = false, valColor,
}: {
  label: string; val: string; bold?: boolean; valColor?: string
}) {
  return (
    <View style={s.taxRow}>
      <Text style={[s.taxRowLabel, bold && { color: '#E5E7EB', fontWeight: '500' as const }]}>
        {label}
      </Text>
      <Text style={[s.taxRowVal, valColor ? { color: valColor } : {}]}>{val}</Text>
    </View>
  )
}

// ─── Profile Card ─────────────────────────────────────────────────────────────

function ProfileCard({ user, entryCount, onLogout }: {
  user: KamaiUser
  entryCount: number
  onLogout: () => void
}) {
  const identifier = user.email || 'Rider'
  const initials = identifier.slice(0, 2).toUpperCase()
  const cityLabel = CITY_LABELS[user.city] || user.city
  const minWage = MIN_WAGE_HOURLY[user.city] || MIN_WAGE_HOURLY['bengaluru']

  return (
    <View style={s.profileCard}>
      {/* Avatar + name row */}
      <View style={s.profileTop}>
        <View style={s.avatar}>
          <Text style={s.avatarText}>{initials}</Text>
        </View>
        <View style={s.profileInfo}>
          <Text style={s.profileIdentifier} numberOfLines={1}>{identifier}</Text>
          <Text style={s.profileMeta}>
            {cityLabel} · {formatJoinDate(user.created_at)}
          </Text>
        </View>
        <TouchableOpacity
          style={s.logoutBtn}
          onPress={onLogout}
          activeOpacity={0.7}
        >
          <Text style={s.logoutText}>Log out</Text>
        </TouchableOpacity>
      </View>

      {/* Divider */}
      <View style={s.profileDivider} />

      {/* Details row */}
      <View style={s.profileDetails}>
        <View style={s.profileDetailItem}>
          <Text style={s.profileDetailVal}>{entryCount}</Text>
          <Text style={s.profileDetailLabel}>Weeks logged</Text>
        </View>
        <View style={s.profileDetailDivider} />
        <View style={s.profileDetailItem}>
          <Text style={s.profileDetailVal}>₹{minWage}/hr</Text>
          <Text style={s.profileDetailLabel}>Min wage · {cityLabel}</Text>
        </View>
        <View style={s.profileDetailDivider} />
        <View style={s.profileDetailItem}>
          <Text style={[s.profileDetailVal, { color: '#10B981' }]}>Free</Text>
          <Text style={s.profileDetailLabel}>Plan</Text>
        </View>
      </View>

      {/* Source note */}
      <Text style={s.profileSource}>
        Min wage · Fairwork India 2024 · Karnataka Labour Dept
      </Text>
    </View>
  )
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function RiderProfileScreen() {
  const insets = useSafeAreaInsets()
  const router = useRouter()

  const [user, setUser] = useState<KamaiUser | null>(null)
  const [entries, setEntries] = useState<EarningsEntry[]>([])
  const [legacyEntryCount, setLegacyEntryCount] = useState(0)
  const [restoringLegacy, setRestoringLegacy] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)

  const [form, setForm] = useState<FormState>({
    platform: 'zepto',
    week_start: getThisMonday(),
    gross: '',
    orders: '',
    hours: '',
    bonus: '0',
    app_fee: '163',
    fuel: '0',
    commission_pct: '20',
    has_pan: true,
    quarterly_gross: '0',
  })

  useFocusEffect(
    useCallback(() => {
      void Promise.all([loadUser(), loadLocalEntries()])
    }, []),
  )

  async function loadUser() {
    try {
      const { data: { user: authUser }, error: userError } = await supabase.auth.getUser()
      if (userError) throw userError

      if (!authUser) {
        setUser(null)
        router.replace('/auth')
        return
      }

      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('city_code, created_at')
        .eq('user_id', authUser.id)
        .single()

      if (profileError) throw profileError

      setUser({
        id: authUser.id,
        email: authUser.email,
        city: profile.city_code,
        created_at: profile.created_at,
      })
    } catch (e) {
      console.error('loadUser error:', e)
    }
  }

  async function loadLocalEntries() {
    try {
      const localEntries = await readRiderEarnings<EarningsEntry>()

      try {
        const remoteEntries = await fetchEarningReports()
        const localById = new Map(localEntries.map(entry => [entry.id, entry]))
        const remoteIds = new Set(remoteEntries.map(entry => entry.id))
        const remoteWithLocalSlots: EarningsEntry[] = remoteEntries.map(entry => ({
          ...entry,
          slots: entry.slots.length > 0
            ? entry.slots
            : localById.get(entry.id)?.slots ?? [],
        }))
        const localOnly = localEntries.filter(entry => !remoteIds.has(entry.id))
        const merged = [...remoteWithLocalSlots, ...localOnly]
          .sort((a, b) => b.created_at.localeCompare(a.created_at))

        await writeRiderEarnings(merged)
        setEntries(merged)
      } catch {
        setEntries(localEntries.sort((a, b) => b.created_at.localeCompare(a.created_at)))
      }

      setLegacyEntryCount(await getLegacyEarningsCount())
    } catch (e) {
      console.error('loadLocalEntries error:', e)
    }
  }

  function handleRestoreLegacyEntries() {
    Alert.alert(
      'Restore old entries?',
      `This will permanently attach ${legacyEntryCount} old device entries to ${user?.email || 'this account'}. Only continue while logged into the account that owns them.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore',
          onPress: async () => {
            setRestoringLegacy(true)
            try {
              const restored = await claimLegacyEarnings<EarningsEntry>()
              setEntries(restored.sort((a, b) => b.week_start.localeCompare(a.week_start)))
              setLegacyEntryCount(0)
            } catch (e: any) {
              Alert.alert('Could not restore entries', e.message || 'Please try again.')
            } finally {
              setRestoringLegacy(false)
            }
          },
        },
      ],
    )
  }

  const onRefresh = useCallback(async () => {
    const startedAt = Date.now()
    setRefreshing(true)
    await Promise.all([loadUser(), loadLocalEntries()])
    const remainingAnimationMs = Math.max(0, 600 - (Date.now() - startedAt))
    if (remainingAnimationMs > 0) {
      await new Promise(resolve => setTimeout(resolve, remainingAnimationMs))
    }
    setRefreshing(false)
  }, [])

  // ─── Logout ──────────────────────────────────────────────────────────────────

  function handleLogout() {
    Alert.alert(
      'Log out?',
      'Your earnings data stays saved on this device. You can log back in anytime.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Log out',
          style: 'destructive',
          onPress: async () => {
            const { error: logoutError } = await supabase.auth.signOut()
            if (logoutError) {
              Alert.alert('Could not log out', logoutError.message)
              return
            }
            setUser(null)
            router.replace('/auth')
          },
        },
      ]
    )
  }

  function switchPlatform(p: PlatformKey) {
    const pd = PLATFORM_DATA[p]
    setForm(f => ({
      ...f,
      platform: p,
      app_fee: String(Math.round((pd.appFeeMin + pd.appFeeMax) / 2)),
      commission_pct: String(Math.round((pd.commissionMin + pd.commissionMax) / 2)),
    }))
  }

  async function saveEntry() {
    const gross = parseFloat(form.gross) || 0
    const orders = parseInt(form.orders, 10) || 0
    const hours = parseFloat(form.hours) || 0

    if (!gross || !orders || !hours) {
      Alert.alert('Missing fields', 'Gross earnings, orders, and hours are required.')
      return
    }

    setSaving(true)

    const bonus = parseFloat(form.bonus) || 0
    const app_fee = parseFloat(form.app_fee) || 0
    const fuel = parseFloat(form.fuel) || 0
    const commission_pct = parseFloat(form.commission_pct) || 20
    const quarterly_gross = parseFloat(form.quarterly_gross) || 0

    const calc = calculateEarnings({
      gross, bonus, commissionPct: commission_pct, appFee: app_fee,
      fuel, hours, orders, hasPan: form.has_pan, quarterlyGross: quarterly_gross,
    })

    const entry: EarningsEntry = {
      id: Crypto.randomUUID(),
      platform: form.platform,
      week_start: form.week_start,
      gross, orders, hours, bonus, app_fee, fuel,
      commission_pct, has_pan: form.has_pan, quarterly_gross,
      commission: calc.commission,
      gst_on_commission: calc.gstOnCommission,
      tds: calc.tds,
      tds_applies: calc.tdsApplies,
      net_from_platform: calc.netFromPlatform,
      true_take_home: calc.trueTakeHome,
      effective_rate: calc.effectiveHourlyRate,
      per_order: calc.perOrder,
      platform_tax_rate: calc.platformTaxRate,
      annual_projection: calc.annualProjection,
      synced: false,
      created_at: new Date().toISOString(),
    }

    const updated = [entry, ...entries]
    await writeRiderEarnings(updated)
    setEntries(updated)
    setShowAddModal(false)
    resetForm()
    setSaving(false)

    try {
      await syncEarningReport({
        clientRecordId: entry.id,
        platform: entry.platform,
        periodStart: entry.week_start,
        hours: entry.hours,
        orders: entry.orders,
        gross: entry.gross,
        bonus: entry.bonus,
        commission: entry.commission,
        gstOnCommission: entry.gst_on_commission,
        tds: entry.tds,
        platformFees: entry.app_fee,
        fuelCost: entry.fuel,
        hasPan: entry.has_pan,
        quarterlyGross: entry.quarterly_gross,
      })
      const synced = updated.map(e => e.id === entry.id ? { ...e, synced: true } : e)
      await writeRiderEarnings(synced)
      setEntries(synced)
    } catch (_) {}
  }

  function resetForm() {
    setForm({
      platform: 'zepto',
      week_start: getThisMonday(),
      gross: '', orders: '', hours: '',
      bonus: '0', app_fee: '163', fuel: '0',
      commission_pct: '20', has_pan: true, quarterly_gross: '0',
    })
  }

  // ─── Derived insights ─────────────────────────────────────────────────────────

  const thisMonth = entries.filter(e => {
    const d = new Date(e.week_start + 'T00:00:00')
    const now = new Date()
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
  })
  const thisMonthTotal = thisMonth.reduce((s, e) => s + e.true_take_home, 0)

  const platformBuckets: Record<string, { takeHome: number; hours: number; weeks: number }> = {}
  entries.forEach(e => {
    if (!platformBuckets[e.platform]) {
      platformBuckets[e.platform] = { takeHome: 0, hours: 0, weeks: 0 }
    }
    platformBuckets[e.platform].takeHome += e.true_take_home
    platformBuckets[e.platform].hours += e.hours
    platformBuckets[e.platform].weeks += 1
  })

  const platformRanked = Object.entries(platformBuckets)
    .map(([p, d]) => ({
      platform: p as PlatformKey,
      rate: d.hours > 0 ? d.takeHome / d.hours : 0,
      weeks: d.weeks,
      hours: d.hours,
    }))
    .sort((a, b) => b.rate - a.rate)

  const bestPlatform = platformRanked[0]
  const worstPlatform = platformRanked[platformRanked.length - 1]

  let loyaltyPenalty = 0
  if (
    bestPlatform && worstPlatform &&
    bestPlatform.platform !== worstPlatform.platform &&
    worstPlatform.hours > 0
  ) {
    loyaltyPenalty = (bestPlatform.rate - worstPlatform.rate) * worstPlatform.hours
  }

  const latestRate = entries[0]?.effective_rate ?? 0
  const belowMinWage = latestRate > 0 && latestRate < MIN_WAGE

  const annual = entries.reduce(
    (acc, e) => ({
      gross: acc.gross + e.gross + e.bonus,
      commission: acc.commission + e.commission,
      gst: acc.gst + e.gst_on_commission,
      tds: acc.tds + e.tds,
      app_fee: acc.app_fee + e.app_fee,
      net: acc.net + e.true_take_home,
    }),
    { gross: 0, commission: 0, gst: 0, tds: 0, app_fee: 0, net: 0 }
  )

  async function shareWithCA() {
    const lines = [
      'KAMAI — Earnings Summary (FY 2025–26)',
      `Generated: ${new Date().toLocaleDateString('en-IN')}`,
      '',
      `Total gross income:        ${formatINR(annual.gross)}`,
      `Platform commissions:      −${formatINR(annual.commission)}`,
      `GST on commission (18%):   −${formatINR(annual.gst)}`,
      `TDS deducted (Sec 194C):   −${formatINR(annual.tds)}`,
      `Platform app fees:         −${formatINR(annual.app_fee)}`,
      `Net take-home:             ${formatINR(annual.net)}`,
      '',
      `TDS refund estimate:       +${formatINR(annual.tds)}`,
      `(File ITR-1 if annual gross < ₹5,00,000)`,
      '',
      `Total weeks recorded: ${entries.length}`,
      `Data source: Rider's own records via Kamai app`,
      `Tax formula: CBDT / Income Tax Act Sec 194C`,
    ].join('\n')
    try {
      await Share.share({ message: lines, title: 'Kamai Earnings Summary' })
    } catch (_) {}
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <View style={{ flex: 1, backgroundColor: '#0F0F0F' }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + 14, paddingBottom: 100 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#10B981"
            colors={['#10B981']}
            title="Syncing earnings…"
            titleColor="#10B981"
          />
        }
        alwaysBounceVertical
        showsVerticalScrollIndicator={false}
      >
        {refreshing && (
          <View style={s.syncBanner}>
            <ActivityIndicator size="small" color="#10B981" />
            <Text style={s.syncBannerText}>Syncing your latest earnings…</Text>
          </View>
        )}

        {/* ── Header ── */}
        <View style={s.header}>
          <Text style={s.title}>Rider Profile</Text>
          <Text style={s.subtitle}>FY 2025–26</Text>
        </View>

        {/* ── Profile Card ── */}
        {user && (
          <ProfileCard
            user={user}
            entryCount={entries.length}
            onLogout={handleLogout}
          />
        )}

        {/* ── Stats strip ── */}
        {entries.length > 0 && (
          <View style={s.statsRow}>
            <View style={s.statCard}>
              <Text style={s.statLabel}>This month</Text>
              <Text style={[s.statVal, { color: '#10B981' }]}>{formatINR(thisMonthTotal)}</Text>
            </View>
            <View style={s.statCard}>
              <Text style={s.statLabel}>Best platform</Text>
              <Text style={[s.statVal, { color: PLATFORM_DATA[bestPlatform?.platform ?? 'zepto']?.color ?? '#10B981' }]}>
                {bestPlatform
                  ? PLATFORM_DATA[bestPlatform.platform]?.label ?? bestPlatform.platform
                  : '–'}
              </Text>
            </View>
            <View style={s.statCard}>
              <Text style={s.statLabel}>Left on table</Text>
              <Text style={[s.statVal, { color: loyaltyPenalty > 0 ? '#EF4444' : '#6B7280' }]}>
                {loyaltyPenalty > 0 ? formatINR(loyaltyPenalty) : '–'}
              </Text>
            </View>
          </View>
        )}

        {/* ── Empty state ── */}
        {entries.length === 0 && (
          <View style={s.emptyState}>
            <Text style={s.emptyIcon}>📊</Text>
            <Text style={s.emptyTitle}>No entries yet</Text>
            <Text style={s.emptySubtitle}>
              Use the <Text style={{ color: '#10B981', fontWeight: '700' }}>Calculate tab</Text> to add your first week's earnings.{'\n'}
              Your data stays on your device.
            </Text>
            {legacyEntryCount > 0 && (
              <TouchableOpacity
                style={[s.restoreBtn, restoringLegacy && s.restoreBtnDisabled]}
                onPress={handleRestoreLegacyEntries}
                disabled={restoringLegacy}
                activeOpacity={0.8}
              >
                <Text style={s.restoreBtnText}>
                  {restoringLegacy
                    ? 'Restoring…'
                    : `Restore ${legacyEntryCount} old device entries`}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* ── Insights ── */}
        {entries.length > 0 && (
          <>
            <Text style={s.sectionLabel}>Smart insights</Text>
            <View style={s.insightList}>

              {belowMinWage && (
                <View style={s.insightCard}>
                  <View style={[s.insightTag, { backgroundColor: '#2e0a0a' }]}>
                    <Text style={[s.insightTagTxt, { color: '#EF4444' }]}>Min wage alert</Text>
                  </View>
                  <Text style={s.insightTitle}>
                    Your rate{' '}
                    <Text style={{ color: '#EF4444', fontWeight: '600' }}>
                      {formatINR(latestRate)}/hr
                    </Text>{' '}
                    is below Bengaluru minimum of ₹78.19/hr
                  </Text>
                  <Text style={s.insightSub}>
                    Source: Fairwork India 2024 · Karnataka Labour Dept
                  </Text>
                </View>
              )}

              {bestPlatform && platformRanked.length > 1 && (
                <View style={s.insightCard}>
                  <View style={[s.insightTag, { backgroundColor: '#2a1e00' }]}>
                    <Text style={[s.insightTagTxt, { color: '#F59E0B' }]}>Best platform</Text>
                  </View>
                  <Text style={s.insightTitle}>
                    <Text style={{ color: PLATFORM_DATA[bestPlatform.platform]?.color, fontWeight: '600' }}>
                      {PLATFORM_DATA[bestPlatform.platform]?.label}
                    </Text>{' '}
                    pays you{' '}
                    <Text style={{ color: '#10B981', fontWeight: '600' }}>
                      {formatINR(bestPlatform.rate)}/hr
                    </Text>{' '}
                    on average
                  </Text>
                  <Text style={s.insightSub}>
                    Based on {bestPlatform.weeks} week{bestPlatform.weeks !== 1 ? 's' : ''} of data
                  </Text>
                </View>
              )}

              {loyaltyPenalty > 500 && (
                <View style={s.insightCard}>
                  <View style={[s.insightTag, { backgroundColor: '#0a2e1e' }]}>
                    <Text style={[s.insightTagTxt, { color: '#10B981' }]}>Loyalty penalty</Text>
                  </View>
                  <Text style={s.insightTitle}>
                    You left{' '}
                    <Text style={{ color: '#10B981', fontWeight: '600' }}>
                      {formatINR(loyaltyPenalty)}
                    </Text>{' '}
                    on the table by not switching to{' '}
                    {PLATFORM_DATA[bestPlatform.platform]?.label}
                  </Text>
                  <Text style={s.insightSub}>
                    {formatINR(worstPlatform.rate)}/hr on {PLATFORM_DATA[worstPlatform.platform]?.label} vs{' '}
                    {formatINR(bestPlatform.rate)}/hr on {PLATFORM_DATA[bestPlatform.platform]?.label}
                  </Text>
                </View>
              )}

            </View>
          </>
        )}

        {/* ── Weekly entries ── */}
        {entries.length > 0 && (
          <>
            <Text style={s.sectionLabel}>Weekly entries</Text>
            <View style={s.entriesList}>
              {entries.map(entry => {
                const expanded = expandedId === entry.id
                const pd = PLATFORM_DATA[entry.platform]
                const rateColor = entry.effective_rate >= MIN_WAGE ? '#10B981' : '#F59E0B'
                const barPct = Math.min(100, (entry.effective_rate / MIN_WAGE) * 100)

                return (
                  <TouchableOpacity
                    key={entry.id}
                    style={s.entryCard}
                    onPress={() => setExpandedId(expanded ? null : entry.id)}
                    activeOpacity={0.8}
                  >
                    <View style={s.entryTop}>
                      <View style={s.entryLeft}>
                        <View style={[s.platformPill, { backgroundColor: pd.color + '22', borderColor: pd.color + '55' }]}>
                          <Text style={[s.platformPillTxt, { color: pd.color }]}>{pd.label}</Text>
                        </View>
                        <Text style={s.entryWeek}>{formatWeek(entry.week_start)}</Text>
                      </View>
                      <View style={s.entryRight}>
                        <Text style={s.entryNet}>{formatINR(entry.true_take_home)}</Text>
                        <Text style={s.entryChevron}>{expanded ? '▴' : '▾'}</Text>
                      </View>
                    </View>

                    <View style={s.entryMeta}>
                      <Text style={s.metaItem}>
                        <Text style={s.metaLabel}>Orders </Text>
                        <Text style={s.metaVal}>{entry.orders}</Text>
                      </Text>
                      <Text style={s.metaDot}>·</Text>
                      <Text style={s.metaItem}>
                        <Text style={s.metaLabel}>Hours </Text>
                        <Text style={s.metaVal}>{entry.hours}</Text>
                      </Text>
                      <Text style={s.metaDot}>·</Text>
                      <Text style={s.metaItem}>
                        <Text style={s.metaLabel}>Per order </Text>
                        <Text style={s.metaVal}>{formatINR(entry.per_order)}</Text>
                      </Text>
                      <View style={{ flex: 1 }} />
                      <View style={[s.rateChip, { backgroundColor: rateColor + '18' }]}>
                        <Text style={[s.rateChipTxt, { color: rateColor }]}>
                          {formatINR(entry.effective_rate)}/hr
                        </Text>
                      </View>
                    </View>

                    <View style={s.entryBar}>
                      <View style={[s.entryBarFill, { width: `${barPct}%` as any, backgroundColor: rateColor }]} />
                    </View>

                    {expanded && (
                      <View style={s.breakdown}>
                        <View style={s.bdDivider} />
                        <BreakdownRow label="Gross delivery fees" val={formatINR(entry.gross)} />
                        {entry.bonus > 0 && (
                          <BreakdownRow label="+ Bonus / surge" val={formatINR(entry.bonus)} valColor="#10B981" />
                        )}
                        <BreakdownRow label="= Total gross" val={formatINR(entry.gross + entry.bonus)} bold />
                        <View style={s.bdDivider} />
                        <BreakdownRow label={`− Commission (${entry.commission_pct}%)`} val={`−${formatINR(entry.commission)}`} valColor="#EF4444" />
                        <BreakdownRow label="− GST on commission (18%)" val={`−${formatINR(entry.gst_on_commission)}`} valColor="#EF4444" />
                        {entry.tds_applies && (
                          <BreakdownRow
                            label={`− TDS Sec 194C (${entry.has_pan ? '1%' : '2%'})`}
                            val={`−${formatINR(entry.tds)}`}
                            valColor="#EF4444"
                          />
                        )}
                        <BreakdownRow label="− Platform app fee" val={`−${formatINR(entry.app_fee)}`} valColor="#EF4444" />
                        <BreakdownRow label="= Net from platform" val={formatINR(entry.net_from_platform)} bold />
                        <View style={s.bdDivider} />
                        <BreakdownRow label="− Fuel (your operating cost)" val={`−${formatINR(entry.fuel)}`} valColor="#6B7280" />
                        <BreakdownRow label="True take-home" val={formatINR(entry.true_take_home)} bold valColor="#10B981" />
                        <View style={s.bdDivider} />
                        <BreakdownRow label="Platform tax rate" val={`${entry.platform_tax_rate.toFixed(1)}%`} />
                        <BreakdownRow
                          label="Effective hourly rate"
                          val={`${formatINR(entry.effective_rate)}/hr`}
                          valColor={entry.effective_rate >= MIN_WAGE ? '#10B981' : '#F59E0B'}
                        />
                        <BreakdownRow label="Bengaluru minimum wage" val="₹78.19/hr" />
                        <BreakdownRow
                          label="vs minimum wage"
                          val={
                            entry.effective_rate >= MIN_WAGE
                              ? `+${formatINR(entry.effective_rate - MIN_WAGE)}/hr`
                              : `−${formatINR(MIN_WAGE - entry.effective_rate)}/hr`
                          }
                          valColor={entry.effective_rate >= MIN_WAGE ? '#10B981' : '#EF4444'}
                          bold
                        />
                        {entry.tds_applies && (
                          <View style={s.tdsAlert}>
                            <Text style={s.tdsAlertTxt}>
                              TDS of {formatINR(entry.tds)} was deducted. File ITR-1 to claim a refund if your total annual income is below ₹5 lakh.
                            </Text>
                          </View>
                        )}
                        {!entry.synced && (
                          <Text style={s.unsyncedNote}>Not synced to server yet — saved locally</Text>
                        )}
                        <Text style={s.sourceFooter}>
                          Fairwork India 2024 · CBDT · Income Tax Act Sec 194C
                        </Text>
                      </View>
                    )}
                  </TouchableOpacity>
                )
              })}
            </View>
          </>
        )}

        {/* ── Annual tax summary ── */}
        {entries.length > 0 && (
          <>
            <Text style={s.sectionLabel}>Annual tax summary</Text>
            <View style={s.taxCard}>
              <View style={s.taxHeader}>
                <Text style={s.taxTitle}>FY 2025–26 · ITR-1 ready</Text>
                <View style={s.taxBadge}>
                  <Text style={s.taxBadgeTxt}>{entries.length} weeks</Text>
                </View>
              </View>
              <View style={s.taxRows}>
                <TaxRow label="Total gross income" val={formatINR(annual.gross)} />
                <TaxRow label="Platform commissions" val={`−${formatINR(annual.commission)}`} valColor="#EF4444" />
                <TaxRow label="GST on commission (18%)" val={`−${formatINR(annual.gst)}`} valColor="#EF4444" />
                <TaxRow label="TDS deducted (Sec 194C)" val={`−${formatINR(annual.tds)}`} valColor="#EF4444" />
                <TaxRow label="Platform app fees" val={`−${formatINR(annual.app_fee)}`} valColor="#EF4444" />
                <View style={s.taxDivider} />
                <TaxRow label="Net take-home" val={formatINR(annual.net)} bold valColor="#10B981" />
                {annual.tds > 0 && (
                  <TaxRow label="TDS refund estimate" val={`+${formatINR(annual.tds)}`} valColor="#10B981" />
                )}
              </View>
              <TouchableOpacity style={s.shareBtn} onPress={shareWithCA} activeOpacity={0.8}>
                <Text style={s.shareBtnTxt}>Share with CA · Copy summary</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </ScrollView>

      {/* ── FAB ── */}
      <TouchableOpacity
        style={[s.fab, { bottom: insets.bottom + 80 }]}
        onPress={() => setShowAddModal(true)}
        activeOpacity={0.85}
      >
        <Text style={s.fabTxt}>+</Text>
      </TouchableOpacity>

      {/* ── Add Entry Modal ── */}
      <Modal
        visible={showAddModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowAddModal(false)}
      >
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <Pressable style={s.modalOverlay} onPress={() => setShowAddModal(false)} />
          <View style={[s.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={s.modalHandle} />
            <Text style={s.modalTitle}>Add weekly entry</Text>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

              <Text style={s.fieldLabel}>Platform</Text>
              <View style={s.platformBtns}>
                {(['zepto', 'blinkit', 'instamart'] as PlatformKey[]).map(p => {
                  const selected = form.platform === p
                  const pd = PLATFORM_DATA[p]
                  return (
                    <TouchableOpacity
                      key={p}
                      style={[s.platformBtn, selected && { backgroundColor: pd.color + '22', borderColor: pd.color + '88' }]}
                      onPress={() => switchPlatform(p)}
                    >
                      <Text style={[s.platformBtnTxt, selected && { color: pd.color }]}>
                        {pd.label}
                      </Text>
                    </TouchableOpacity>
                  )
                })}
              </View>

              <Text style={s.fieldLabel}>Week starting (Monday)</Text>
              <TextInput
                style={s.input}
                value={form.week_start}
                onChangeText={v => setForm(f => ({ ...f, week_start: v }))}
                placeholder="YYYY-MM-DD"
                placeholderTextColor="#4B5563"
              />

              <View style={s.fieldRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.fieldLabel}>Gross earnings (₹)</Text>
                  <TextInput
                    style={s.input}
                    value={form.gross}
                    onChangeText={v => setForm(f => ({ ...f, gross: v }))}
                    keyboardType="numeric"
                    placeholder="5200"
                    placeholderTextColor="#4B5563"
                  />
                </View>
                <View style={{ width: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={s.fieldLabel}>Orders completed</Text>
                  <TextInput
                    style={s.input}
                    value={form.orders}
                    onChangeText={v => setForm(f => ({ ...f, orders: v }))}
                    keyboardType="numeric"
                    placeholder="68"
                    placeholderTextColor="#4B5563"
                  />
                </View>
              </View>

              <View style={s.fieldRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.fieldLabel}>Hours worked</Text>
                  <TextInput
                    style={s.input}
                    value={form.hours}
                    onChangeText={v => setForm(f => ({ ...f, hours: v }))}
                    keyboardType="numeric"
                    placeholder="60"
                    placeholderTextColor="#4B5563"
                  />
                </View>
                <View style={{ width: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={s.fieldLabel}>Bonus / surge (₹)</Text>
                  <TextInput
                    style={s.input}
                    value={form.bonus}
                    onChangeText={v => setForm(f => ({ ...f, bonus: v }))}
                    keyboardType="numeric"
                    placeholder="0"
                    placeholderTextColor="#4B5563"
                  />
                </View>
              </View>

              <View style={s.fieldRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.fieldLabel}>Platform app fee (₹)</Text>
                  <TextInput
                    style={s.input}
                    value={form.app_fee}
                    onChangeText={v => setForm(f => ({ ...f, app_fee: v }))}
                    keyboardType="numeric"
                    placeholder="175"
                    placeholderTextColor="#4B5563"
                  />
                </View>
                <View style={{ width: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={s.fieldLabel}>Fuel cost (₹)</Text>
                  <TextInput
                    style={s.input}
                    value={form.fuel}
                    onChangeText={v => setForm(f => ({ ...f, fuel: v }))}
                    keyboardType="numeric"
                    placeholder="600"
                    placeholderTextColor="#4B5563"
                  />
                </View>
              </View>

              <View style={s.fieldRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.fieldLabel}>Commission % (from your rider app)</Text>
                  <TextInput
                    style={s.input}
                    value={form.commission_pct}
                    onChangeText={v => setForm(f => ({ ...f, commission_pct: v }))}
                    keyboardType="numeric"
                    placeholder="20"
                    placeholderTextColor="#4B5563"
                  />
                </View>
                <View style={{ width: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={s.fieldLabel}>Quarterly gross so far (₹)</Text>
                  <TextInput
                    style={s.input}
                    value={form.quarterly_gross}
                    onChangeText={v => setForm(f => ({ ...f, quarterly_gross: v }))}
                    keyboardType="numeric"
                    placeholder="30000"
                    placeholderTextColor="#4B5563"
                  />
                </View>
              </View>

              <View style={s.toggleRow}>
                <View style={{ flex: 1, marginRight: 12 }}>
                  <Text style={s.toggleLabel}>I have PAN card</Text>
                  <Text style={s.toggleSub}>TDS at 1% (with PAN) vs 2% (without)</Text>
                </View>
                <Switch
                  value={form.has_pan}
                  onValueChange={v => setForm(f => ({ ...f, has_pan: v }))}
                  trackColor={{ false: '#374151', true: '#10B981' }}
                  thumbColor="#fff"
                  ios_backgroundColor="#374151"
                />
              </View>

              <TouchableOpacity
                style={[s.saveBtn, saving && { opacity: 0.6 }]}
                onPress={saveEntry}
                activeOpacity={0.9}
                disabled={saving}
              >
                <Text style={s.saveBtnTxt}>{saving ? 'Saving…' : 'Calculate & Save'}</Text>
              </TouchableOpacity>

            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  header: { paddingHorizontal: 18, paddingBottom: 14 },
  title: { color: '#FFFFFF', fontSize: 24, fontWeight: '700', letterSpacing: -0.5 },
  subtitle: { color: '#6B7280', fontSize: 12, marginTop: 3 },

  // Profile card
  profileCard: {
    marginHorizontal: 14,
    marginBottom: 18,
    backgroundColor: '#141414',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#1F1F1F',
    overflow: 'hidden',
  },
  profileTop: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#10B98120',
    borderWidth: 1,
    borderColor: '#10B98150',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#10B981',
    fontSize: 16,
    fontWeight: '800',
  },
  profileInfo: {
    flex: 1,
  },
  profileIdentifier: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  profileMeta: {
    color: '#6B7280',
    fontSize: 11,
    marginTop: 2,
  },
  logoutBtn: {
    backgroundColor: '#EF444415',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: '#EF444430',
  },
  logoutText: {
    color: '#EF4444',
    fontSize: 12,
    fontWeight: '700',
  },
  profileDivider: {
    height: 1,
    backgroundColor: '#1F1F1F',
  },
  profileDetails: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
  },
  profileDetailItem: {
    flex: 1,
    alignItems: 'center',
  },
  profileDetailVal: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  profileDetailLabel: {
    color: '#6B7280',
    fontSize: 10,
    marginTop: 2,
    textAlign: 'center',
  },
  profileDetailDivider: {
    width: 1,
    height: 28,
    backgroundColor: '#1F1F1F',
  },
  profileSource: {
    color: '#374151',
    fontSize: 9,
    textAlign: 'center',
    paddingBottom: 8,
  },

  statsRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, marginBottom: 18 },
  statCard: {
    flex: 1, backgroundColor: '#141414', borderWidth: 0.5,
    borderColor: '#222222', borderRadius: 12, padding: 10,
  },
  statLabel: { color: '#6B7280', fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
  statVal: { fontSize: 14, fontWeight: '700', marginTop: 4 },

  sectionLabel: {
    color: '#4B5563', fontSize: 10, textTransform: 'uppercase',
    letterSpacing: 0.8, fontWeight: '600', paddingHorizontal: 16, marginBottom: 8,
  },

  syncBanner: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#10B98140',
    backgroundColor: '#0B2E23',
  },
  syncBannerText: { color: '#34D399', fontSize: 12, fontWeight: '600' },

  emptyState: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 40 },
  emptyIcon: { fontSize: 44, marginBottom: 16 },
  emptyTitle: { color: '#E5E7EB', fontSize: 18, fontWeight: '600', marginBottom: 8 },
  emptySubtitle: { color: '#6B7280', fontSize: 13, textAlign: 'center', lineHeight: 20 },
  restoreBtn: {
    marginTop: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#10B981',
    backgroundColor: '#10B98118',
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  restoreBtnDisabled: { opacity: 0.6 },
  restoreBtnText: { color: '#10B981', fontSize: 13, fontWeight: '700' },

  insightList: { paddingHorizontal: 14, gap: 8, marginBottom: 18 },
  insightCard: {
    backgroundColor: '#141414', borderRadius: 12, borderWidth: 0.5, borderColor: '#1F1F1F', padding: 13,
  },
  insightTag: { alignSelf: 'flex-start', borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2, marginBottom: 7 },
  insightTagTxt: { fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  insightTitle: { color: '#E5E7EB', fontSize: 13, fontWeight: '500', lineHeight: 19 },
  insightSub: { color: '#6B7280', fontSize: 11, marginTop: 4 },

  entriesList: { paddingHorizontal: 14, gap: 8, marginBottom: 18 },
  entryCard: {
    backgroundColor: '#141414', borderWidth: 0.5, borderColor: '#1F1F1F', borderRadius: 12, padding: 13,
  },
  entryTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 },
  entryLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  entryRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  platformPill: { borderRadius: 6, borderWidth: 0.5, paddingHorizontal: 8, paddingVertical: 3 },
  platformPillTxt: { fontSize: 10, fontWeight: '700' },
  entryWeek: { color: '#6B7280', fontSize: 10 },
  entryNet: { color: '#10B981', fontSize: 16, fontWeight: '700' },
  entryChevron: { color: '#4B5563', fontSize: 10 },

  entryMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 9, flexWrap: 'wrap' },
  metaItem: {},
  metaLabel: { color: '#4B5563', fontSize: 10 },
  metaVal: { color: '#9CA3AF', fontSize: 10, fontWeight: '500' },
  metaDot: { color: '#374151', fontSize: 10 },
  rateChip: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  rateChipTxt: { fontSize: 10, fontWeight: '600' },

  entryBar: { height: 2, backgroundColor: '#1F1F1F', borderRadius: 1, overflow: 'hidden' },
  entryBarFill: { height: 2, borderRadius: 1 },

  breakdown: { marginTop: 6 },
  bdDivider: { height: 0.5, backgroundColor: '#1F1F1F', marginVertical: 9 },
  bdRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 3 },
  bdLabel: { color: '#6B7280', fontSize: 12, flex: 1, marginRight: 8 },
  bdLabelBold: { color: '#E5E7EB', fontWeight: '600' },
  bdVal: { color: '#9CA3AF', fontSize: 12 },
  bdValBold: { fontWeight: '600' },
  tdsAlert: { backgroundColor: '#0a2e1e', borderRadius: 8, padding: 10, marginTop: 10 },
  tdsAlertTxt: { color: '#10B981', fontSize: 11, lineHeight: 17 },
  unsyncedNote: { color: '#4B5563', fontSize: 10, textAlign: 'center', marginTop: 10 },
  sourceFooter: { color: '#374151', fontSize: 10, textAlign: 'center', marginTop: 10 },

  taxCard: {
    marginHorizontal: 14, backgroundColor: '#141414', borderWidth: 0.5,
    borderColor: '#1F1F1F', borderRadius: 12, overflow: 'hidden', marginBottom: 18,
  },
  taxHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: 13, borderBottomWidth: 0.5, borderBottomColor: '#1F1F1F',
  },
  taxTitle: { color: '#E5E7EB', fontSize: 13, fontWeight: '500' },
  taxBadge: { backgroundColor: '#0a2e1e', borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2 },
  taxBadgeTxt: { color: '#10B981', fontSize: 9, fontWeight: '700' },
  taxRows: { padding: 13, gap: 8 },
  taxRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  taxRowLabel: { color: '#6B7280', fontSize: 11 },
  taxRowVal: { color: '#9CA3AF', fontSize: 11, fontWeight: '500' },
  taxDivider: { height: 0.5, backgroundColor: '#1F1F1F', marginVertical: 2 },
  shareBtn: { margin: 13, marginTop: 4, backgroundColor: '#0a2e1e', borderRadius: 8, padding: 11, alignItems: 'center' },
  shareBtnTxt: { color: '#10B981', fontSize: 12, fontWeight: '600' },

  fab: {
    position: 'absolute', right: 16, width: 52, height: 52,
    backgroundColor: '#10B981', borderRadius: 26, alignItems: 'center', justifyContent: 'center',
  },
  fabTxt: { color: '#000000', fontSize: 30, fontWeight: '700', lineHeight: 34, marginTop: -2 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)' },
  modalSheet: {
    backgroundColor: '#141414', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingTop: 16, maxHeight: '88%',
  },
  modalHandle: { width: 36, height: 3, backgroundColor: '#374151', borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
  modalTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: '600', marginBottom: 16 },

  platformBtns: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  platformBtn: {
    flex: 1, backgroundColor: '#0F0F0F', borderWidth: 0.5, borderColor: '#2a2a2a',
    borderRadius: 8, paddingVertical: 9, alignItems: 'center',
  },
  platformBtnTxt: { color: '#6B7280', fontSize: 12, fontWeight: '600' },
  fieldLabel: { color: '#6B7280', fontSize: 11, marginBottom: 6, fontWeight: '500' },
  input: {
    backgroundColor: '#0F0F0F', borderWidth: 0.5, borderColor: '#2a2a2a',
    borderRadius: 8, padding: 12, color: '#FFFFFF', fontSize: 14, marginBottom: 14,
  },
  fieldRow: { flexDirection: 'row' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, marginBottom: 16 },
  toggleLabel: { color: '#E5E7EB', fontSize: 13, fontWeight: '500' },
  toggleSub: { color: '#6B7280', fontSize: 11, marginTop: 2 },
  saveBtn: { backgroundColor: '#10B981', borderRadius: 10, padding: 15, alignItems: 'center', marginTop: 4, marginBottom: 8 },
  saveBtnTxt: { color: '#000000', fontSize: 15, fontWeight: '700' },
})

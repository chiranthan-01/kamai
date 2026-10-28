import React, { useEffect, useRef, useState, useCallback } from 'react'
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Modal,
  Animated,
  AppState,
  ActivityIndicator,
  RefreshControl,
  Dimensions,
} from 'react-native'
import MapView, { Marker, Circle, PROVIDER_DEFAULT } from 'react-native-maps'
import * as Location from 'expo-location'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { io, Socket } from 'socket.io-client'
import axios from 'axios'
import { useFocusEffect } from 'expo-router'
import { API_BASE_URL, PLATFORM_DATA, BASELINE_RIDERS, SCARCITY_HOT, SCARCITY_WARM } from '../../constants/kamai'

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

type Opportunity = 'HOT' | 'WARM' | 'BALANCED'

interface Darkstore {
  id: string
  name: string
  platform: 'zepto' | 'blinkit' | 'instamart'
  area: string
  city: string
  address: string
  latitude: number
  longitude: number
  activeRiders: number
  scarcityScore: number
  opportunity: Opportunity
  ridersNeeded: number
}

interface WeatherData {
  isRaining: boolean
  weatherCode: number
  temperature: number
  windspeed: number
  description: string
  surgeActive: boolean
  // surge info per platform
  surgeBonusMin: number
  surgeBonusMax: number
}

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const SCREEN_HEIGHT = Dimensions.get('window').height
const MAP_HEIGHT = SCREEN_HEIGHT * 0.42
// Bangalore coordinates for weather API
const BANGALORE_LAT = 12.9716
const BANGALORE_LON = 77.5946
const KORAMANGALA_CENTER = { latitude: 12.9352, longitude: 77.6245 }
const PING_INTERVAL_MS = 2 * 60 * 1000 // 2 minutes

// WMO weather codes that trigger surge
// 51–67: drizzle/rain, 80–82: showers, 95–99: thunderstorm
const RAIN_CODES = [51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99]

// Source: verified from platform partner pages + pickmywork.com 2026
const WEATHER_SURGE_DATA = {
  zepto:     { min: 15, max: 25, note: 'Rain Surge — highest surge payer' },
  blinkit:   { min: 10, max: 20, note: 'Surge Pay — per order during high demand' },
  instamart: { min: 10, max: 15, note: 'Weather bonus — MG target easier to hit' },
}

const OPPORTUNITY_CONFIG = {
  HOT:      { color: '#EF4444', bg: '#3B0F0F', label: '🔴 HOT',  text: 'High demand — go now' },
  WARM:     { color: '#F59E0B', bg: '#3B2A0F', label: '🟡 WARM', text: 'More riders needed' },
  BALANCED: { color: '#10B981', bg: '#0D2B1F', label: '🟢 OK',   text: 'Coverage is good' },
}

const PLATFORM_FILTER_OPTIONS = [
  { key: 'all',       label: 'All' },
  { key: 'zepto',     label: 'Zepto' },
  { key: 'blinkit',   label: 'Blinkit' },
  { key: 'instamart', label: 'Instamart' },
]

function weatherCodeToDescription(code: number): string {
  if (code === 0) return 'Clear sky'
  if (code <= 3) return 'Partly cloudy'
  if (code <= 9) return 'Overcast'
  if (code <= 19) return 'Fog / mist'
  if (code <= 29) return 'Light drizzle'
  if (code <= 39) return 'Drizzle'
  if (code <= 49) return 'Freezing drizzle'
  if (code <= 59) return 'Rain'
  if (code <= 69) return 'Heavy rain'
  if (code <= 79) return 'Snow'
  if (code <= 82) return 'Rain showers'
  if (code <= 86) return 'Snow showers'
  if (code <= 94) return 'Thunderstorm'
  return 'Thunderstorm with hail'
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

async function getOrCreateAnonId(): Promise<string> {
  try {
    const existing = await AsyncStorage.getItem('kamai_anon_id')
    if (existing) return existing
    const id = 'rider-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9)
    await AsyncStorage.setItem('kamai_anon_id', id)
    return id
  } catch {
    return 'rider-' + Date.now().toString(36)
  }
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)}m away`
  return `${km.toFixed(1)}km away`
}

// ─────────────────────────────────────────────
// WEATHER SURGE BANNER
// ─────────────────────────────────────────────

function WeatherSurgeBanner({ weather }: { weather: WeatherData | null }) {
  if (!weather || !weather.surgeActive) return null

  return (
    <View style={styles.surgeBanner}>
      <View style={styles.surgeBannerInner}>
        <View style={styles.surgeLeft}>
          <Text style={styles.surgeIcon}>🌧️</Text>
          <View>
            <Text style={styles.surgeTitle}>
              Rain Surge Active · {weather.description}
            </Text>
            <Text style={styles.surgeSubtitle}>
              Zepto +₹15–25/order · Blinkit +₹10–20 · Instamart +₹10–15
            </Text>
          </View>
        </View>
        <View style={styles.surgeTempBadge}>
          <Text style={styles.surgeTempText}>{Math.round(weather.temperature)}°C</Text>
        </View>
      </View>
      <Text style={styles.surgeSource}>
        Source: platform partner pages 2026 · Weather: Open-Meteo
      </Text>
    </View>
  )
}

// non-surge weather bar (subtle, always visible)
function WeatherBar({ weather }: { weather: WeatherData | null }) {
  if (!weather || weather.surgeActive) return null
  return (
    <View style={styles.weatherBar}>
      <Text style={styles.weatherBarIcon}>
        {weather.weatherCode === 0 ? '☀️' : weather.weatherCode <= 3 ? '⛅' : weather.weatherCode <= 9 ? '☁️' : '🌦️'}
      </Text>
      <Text style={styles.weatherBarText}>
        Bengaluru · {weather.description} · {Math.round(weather.temperature)}°C
      </Text>
      <Text style={styles.weatherBarNoSurge}>No surge right now</Text>
    </View>
  )
}

// ─────────────────────────────────────────────
// PRIVACY MODAL
// ─────────────────────────────────────────────

function PrivacyModal({ visible, onAccept }: { visible: boolean; onAccept: () => void }) {
  const fadeAnim = useRef(new Animated.Value(0)).current
  const slideAnim = useRef(new Animated.Value(60)).current

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
        Animated.spring(slideAnim, { toValue: 0, tension: 65, friction: 10, useNativeDriver: true }),
      ]).start()
    }
  }, [visible])

  return (
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent>
      <Animated.View style={[styles.privacyOverlay, { opacity: fadeAnim }]}>
        <Animated.View style={[styles.privacyCard, { transform: [{ translateY: slideAnim }] }]}>
          <Text style={styles.privacyIcon}>🛡️</Text>
          <Text style={styles.privacyTitle}>Before you see the map</Text>
          <Text style={styles.privacySubtitle}>The map works because riders share. Here's the deal:</Text>

          {[
            ['✓', 'ONE tap checks you in. Close the app — tracking stops instantly.'],
            ['✓', 'We store an anonymous ID only. Never your name or phone number.'],
            ['✓', 'Your check-in disappears automatically after 10 minutes.'],
            ['✓', 'We never sell this data. Kamai makes money from ₹99/year Pro — not from you.'],
          ].map(([icon, text], i) => (
            <View key={i} style={styles.privacyRow}>
              <Text style={styles.privacyCheck}>{icon}</Text>
              <Text style={styles.privacyRowText}>{text}</Text>
            </View>
          ))}

          <TouchableOpacity style={styles.privacyButton} onPress={onAccept} activeOpacity={0.85}>
            <Text style={styles.privacyButtonText}>Got it — show me the map</Text>
          </TouchableOpacity>

          <Text style={styles.privacyFairwork}>Map data is voluntary rider check-ins (Waze model)</Text>
        </Animated.View>
      </Animated.View>
    </Modal>
  )
}

// ─────────────────────────────────────────────
// DARKSTORE CARD
// ─────────────────────────────────────────────

function DarkstoreCard({
  store,
  isCheckedIn,
  userLocation,
  onCheckIn,
  onLeave,
  selectedPlatform,
  onSelectPlatform,
  weather,
}: {
  store: Darkstore
  isCheckedIn: boolean
  userLocation: { latitude: number; longitude: number } | null
  onCheckIn: (storeId: string) => void
  onLeave: () => void
  selectedPlatform: string
  onSelectPlatform: (p: string) => void
  weather: WeatherData | null
}) {
  const opp = OPPORTUNITY_CONFIG[store.opportunity]
  const platform = PLATFORM_DATA[store.platform]
  const dist = userLocation
    ? haversineDistance(userLocation.latitude, userLocation.longitude, store.latitude, store.longitude)
    : null

  const scaleAnim = useRef(new Animated.Value(1)).current
  const handlePressIn = () => Animated.spring(scaleAnim, { toValue: 0.97, useNativeDriver: true, tension: 200 }).start()
  const handlePressOut = () => Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, tension: 200 }).start()

  // surge bonus for this card's platform
  const surgeInfo = weather?.surgeActive ? WEATHER_SURGE_DATA[store.platform] : null

  return (
    <Animated.View style={[styles.card, { transform: [{ scale: scaleAnim }] }, isCheckedIn && styles.cardCheckedIn]}>
      {/* Weather surge pill on card */}
      {surgeInfo && (
        <View style={styles.cardSurgePill}>
          <Text style={styles.cardSurgePillText}>
            🌧️ Rain surge +₹{surgeInfo.min}–{surgeInfo.max}/order
          </Text>
        </View>
      )}

      {/* Header row */}
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleGroup}>
          <View style={[styles.platformDot, { backgroundColor: platform.color }]} />
          <View>
            <Text style={styles.cardName} numberOfLines={1}>{store.name}</Text>
            <Text style={styles.cardArea}>{store.area}{dist ? `  ·  ${formatDistance(dist)}` : ''}</Text>
          </View>
        </View>
        <View style={[styles.oppBadge, { backgroundColor: opp.bg, borderColor: opp.color + '40' }]}>
          <Text style={[styles.oppBadgeText, { color: opp.color }]}>{opp.label}</Text>
        </View>
      </View>

      {/* Stats row */}
      <View style={styles.cardStats}>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{store.activeRiders}</Text>
          <Text style={styles.statLabel}>riders here</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Text style={[styles.statValue, store.ridersNeeded > 0 && { color: opp.color }]}>
            {store.ridersNeeded > 0 ? `+${store.ridersNeeded}` : '0'}
          </Text>
          <Text style={styles.statLabel}>needed</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{BASELINE_RIDERS}</Text>
          <Text style={styles.statLabel}>target</Text>
        </View>
      </View>

      {/* Scarcity bar */}
      <View style={styles.scarcityBarBg}>
        <View
          style={[
            styles.scarcityBarFill,
            {
              width: `${Math.min(100, (store.activeRiders / BASELINE_RIDERS) * 100)}%`,
              backgroundColor: opp.color,
            },
          ]}
        />
      </View>
      <Text style={styles.scarcityBarLabel}>{opp.text}</Text>

      {/* Action area */}
      {isCheckedIn ? (
        <View style={styles.checkedInRow}>
          <View style={styles.checkedInBadge}>
            <Text style={styles.checkedInBadgeText}>✓ You're checked in here</Text>
          </View>
          <TouchableOpacity
            style={styles.leaveButton}
            onPress={onLeave}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            activeOpacity={0.8}
          >
            <Text style={styles.leaveButtonText}>Leave</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View>
          <View style={styles.platformSelector}>
            <Text style={styles.platformSelectorLabel}>Check in as:</Text>
            <View style={styles.platformPills}>
              {(['zepto', 'blinkit', 'instamart'] as const).map(p => (
                <TouchableOpacity
                  key={p}
                  style={[
                    styles.platformPill,
                    { borderColor: PLATFORM_DATA[p].color + '60' },
                    selectedPlatform === p && { backgroundColor: PLATFORM_DATA[p].color + '25', borderColor: PLATFORM_DATA[p].color },
                  ]}
                  onPress={() => onSelectPlatform(p)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.platformPillText, selectedPlatform === p && { color: PLATFORM_DATA[p].color }]}>
                    {PLATFORM_DATA[p].label.replace('Swiggy ', '')}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <TouchableOpacity
            style={[styles.checkInButton, { backgroundColor: opp.color + '15', borderColor: opp.color + '50' }]}
            onPress={() => onCheckIn(store.id)}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            activeOpacity={0.8}
          >
            <Text style={[styles.checkInButtonText, { color: opp.color }]}>
              📍 Check in at {store.area}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </Animated.View>
  )
}

// ─────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────

export default function DarkstoreScreen() {
  const [darkstores, setDarkstores] = useState<Darkstore[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [userLocation, setUserLocation] = useState<{ latitude: number; longitude: number } | null>(null)
  const [locationPermission, setLocationPermission] = useState<boolean>(false)
  const [checkedInAt, setCheckedInAt] = useState<string | null>(null)
  const [riderAnonId, setRiderAnonId] = useState<string>('')
  const [selectedPlatform, setSelectedPlatform] = useState<string>('zepto')
  const [platformFilter, setPlatformFilter] = useState<string>('all')
  const [showPrivacy, setShowPrivacy] = useState(false)
  const [socketConnected, setSocketConnected] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [liveFlash, setLiveFlash] = useState(false)
  const [weather, setWeather] = useState<WeatherData | null>(null)
  const [weatherLoading, setWeatherLoading] = useState(true)
  // ── Step 2: separate state for the nearest-20 list (map keeps using `darkstores`) ──
  const [nearbyStores, setNearbyStores] = useState<Darkstore[]>([])
  const [nearbyLoading, setNearbyLoading] = useState(true)

  const socketRef = useRef<Socket | null>(null)
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mapRef = useRef<MapView>(null)
  const liveFlashAnim = useRef(new Animated.Value(1)).current
  const appStateRef = useRef(AppState.currentState)

  // ── Init ──
  useEffect(() => {
    ;(async () => {
      const id = await getOrCreateAnonId()
      setRiderAnonId(id)
      initMap()
      fetchWeather()
    })()
    return () => { cleanup() }
  }, [])

  // Refresh weather every 15 minutes
  useEffect(() => {
    const weatherInterval = setInterval(fetchWeather, 15 * 60 * 1000)
    return () => clearInterval(weatherInterval)
  }, [])

  // ── AppState ──
  useEffect(() => {
    const sub = AppState.addEventListener('change', nextState => {
      if (appStateRef.current === 'active' && nextState.match(/inactive|background/)) {
        if (checkedInAt) postLeave()
      }
      appStateRef.current = nextState
    })
    return () => sub.remove()
  }, [checkedInAt])

  useFocusEffect(
    useCallback(() => {
      return () => { if (checkedInAt) postLeave() }
    }, [checkedInAt])
  )

  // ── Weather fetch — Open-Meteo, free, no API key ──
  async function fetchWeather() {
    try {
      setWeatherLoading(true)
      const url =
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${BANGALORE_LAT}&longitude=${BANGALORE_LON}` +
        `&current=temperature_2m,weathercode,windspeed_10m` +
        `&timezone=Asia%2FKolkata`
      const res = await axios.get(url, { timeout: 8000 })
      const current = res.data?.current
      if (!current) return

      const code: number = current.weathercode ?? 0
      const isRaining = RAIN_CODES.includes(code)

      setWeather({
        isRaining,
        weatherCode: code,
        temperature: current.temperature_2m ?? 28,
        windspeed: current.windspeed_10m ?? 0,
        description: weatherCodeToDescription(code),
        surgeActive: isRaining,
        surgeBonusMin: 10,
        surgeBonusMax: 25,
      })
    } catch (e) {
      console.log('Weather fetch failed (non-critical):', e)
      // Don't crash — weather is bonus info, not core
    } finally {
      setWeatherLoading(false)
    }
  }

  async function initMap() {
    await requestLocation()
    await fetchDarkstores()
    connectSocket()
  }

  async function requestLocation() {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync()
      if (status === 'granted') {
        setLocationPermission(true)
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
        const coords = { latitude: loc.coords.latitude, longitude: loc.coords.longitude }
        setUserLocation(coords)
        fetchNearbyStores(coords.latitude, coords.longitude)
      } else {
        // No permission — fall back to Koramangala center so the list isn't empty
        fetchNearbyStores(KORAMANGALA_CENTER.latitude, KORAMANGALA_CENTER.longitude)
      }
    } catch (e) {
      console.log('Location error:', e)
      fetchNearbyStores(KORAMANGALA_CENTER.latitude, KORAMANGALA_CENTER.longitude)
    }
  }

  // ALL darkstores — used for the map markers + Hot/Warm/OK summary counts
  async function fetchDarkstores(isRefresh = false) {
    try {
      if (isRefresh) setRefreshing(true)
      const res = await axios.get(`${API_BASE_URL}/darkstores`)
      setDarkstores(res.data.darkstores)
      setLastUpdated(new Date())
    } catch (e) {
      console.error('fetchDarkstores error:', e)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  // NEAREST 20 — used for the card list below the map
  async function fetchNearbyStores(lat: number, lon: number) {
    try {
      const res = await axios.get(`${API_BASE_URL}/darkstores`, {
        params: { lat, lon, limit: 20 },
      })
      setNearbyStores(res.data.darkstores)
    } catch (e) {
      console.error('fetchNearbyStores error:', e)
    } finally {
      setNearbyLoading(false)
    }
  }

  function connectSocket() {
    const socket = io(API_BASE_URL, {
      transports: ['websocket'],
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    })
    socket.on('connect', () => {
      setSocketConnected(true)
      socket.emit('rider:subscribe', { city: 'bengaluru' })
    })
    socket.on('disconnect', () => setSocketConnected(false))
    socket.on('scarcity:update', (data: { darkstores: Darkstore[] }) => {
      if (data?.darkstores) {
        setDarkstores(data.darkstores)
        setLastUpdated(new Date())
        flashLive()
      }
    })
    socketRef.current = socket
  }

  function flashLive() {
    setLiveFlash(true)
    Animated.sequence([
      Animated.timing(liveFlashAnim, { toValue: 0.3, duration: 150, useNativeDriver: true }),
      Animated.timing(liveFlashAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
    ]).start(() => setLiveFlash(false))
  }

  function cleanup() {
    if (pingRef.current) clearInterval(pingRef.current)
    if (socketRef.current) socketRef.current.disconnect()
  }

  async function handleCheckIn(darkstoreId: string) {
  if (!riderAnonId) return
  try {
    await axios.post(`${API_BASE_URL}/checkin`, {
      rider_anon_id: riderAnonId,
      darkstore_id: darkstoreId,
      platform: selectedPlatform,
    })
    setCheckedInAt(darkstoreId)
    startPing(darkstoreId)

    // Optimistic update only — do NOT call fetchDarkstores() here
    // The socket scarcity:update will sync the real count within 60s
    // Calling fetch immediately causes double re-render = map glitch
    const bumpRiders = (stores: Darkstore[]) =>
      stores.map(s => {
        if (s.id !== darkstoreId) return s
        const newCount = s.activeRiders + 1
        const score = Math.max(0, 8 - newCount)
        return {
          ...s,
          activeRiders: newCount,
          scarcityScore: score,
          ridersNeeded: score,
          opportunity: (score >= 5 ? 'HOT' : score >= 2 ? 'WARM' : 'BALANCED') as Opportunity,
        }
      })

    setDarkstores(prev => bumpRiders(prev))
    setNearbyStores(prev => bumpRiders(prev))

    // Delay the real refetch by 2s so map has settled before server data comes in
    setTimeout(() => {
      fetchDarkstores()
      if (userLocation) fetchNearbyStores(userLocation.latitude, userLocation.longitude)
    }, 2000)

  } catch (e) {
    console.error('checkIn error:', e)
  }
}

  function startPing(darkstoreId: string) {
    if (pingRef.current) clearInterval(pingRef.current)
    pingRef.current = setInterval(async () => {
      try {
        await axios.post(`${API_BASE_URL}/checkin/ping`, {
          rider_anon_id: riderAnonId,
          darkstore_id: darkstoreId,
        })
      } catch (e) {
        console.error('ping error:', e)
      }
    }, PING_INTERVAL_MS)
  }

  async function postLeave() {
  try {
    if (pingRef.current) clearInterval(pingRef.current)
    await axios.post(`${API_BASE_URL}/checkin/leave`, { rider_anon_id: riderAnonId })
    setCheckedInAt(null)

    // Same fix — optimistic remove, delayed refetch
    const unbumpRiders = (stores: Darkstore[]) =>
      stores.map(s => {
        if (s.id !== checkedInAt) return s
        const newCount = Math.max(0, s.activeRiders - 1)
        const score = Math.max(0, 8 - newCount)
        return {
          ...s,
          activeRiders: newCount,
          scarcityScore: score,
          ridersNeeded: score,
          opportunity: (score >= 5 ? 'HOT' : score >= 2 ? 'WARM' : 'BALANCED') as Opportunity,
        }
      })

    setDarkstores(prev => unbumpRiders(prev))
    setNearbyStores(prev => unbumpRiders(prev))

    setTimeout(() => {
      fetchDarkstores()
      if (userLocation) fetchNearbyStores(userLocation.latitude, userLocation.longitude)
    }, 2000)

  } catch (e) {
    console.error('leave error:', e)
  }
}

  async function handlePrivacyAccept() {
    await AsyncStorage.setItem('kamai_map_privacy_shown', 'true')
    setShowPrivacy(false)
    initMap()
  }

  // ── Step 2: list now reads from nearbyStores, not the full darkstores list ──
  // Checked-in store always floats to top, rest sorted by distance
const filteredStores = (platformFilter === 'all'
  ? nearbyStores
  : nearbyStores.filter(s => s.platform === platformFilter)
).sort((a, b) => {
  if (a.id === checkedInAt) return -1
  if (b.id === checkedInAt) return 1
  if (!userLocation) return 0
  const distA = haversineDistance(userLocation.latitude, userLocation.longitude, a.latitude, a.longitude)
  const distB = haversineDistance(userLocation.latitude, userLocation.longitude, b.latitude, b.longitude)
  return distA - distB
})

  // Counts and map still use the FULL darkstores list
  const hotCount  = darkstores.filter(s => s.opportunity === 'HOT').length
  const warmCount = darkstores.filter(s => s.opportunity === 'WARM').length
  const okCount   = darkstores.filter(s => s.opportunity === 'BALANCED').length

  const mapRegion = userLocation
    ? { ...userLocation, latitudeDelta: 0.06, longitudeDelta: 0.06 }
    : { ...KORAMANGALA_CENTER, latitudeDelta: 0.06, longitudeDelta: 0.06 }

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#10B981" />
        <Text style={styles.loadingText}>Loading darkstores...</Text>
        <Text style={styles.loadingSubtext}>Fetching live rider data from Bengaluru</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <PrivacyModal visible={showPrivacy} onAccept={handlePrivacyAccept} />

      {/* ── Header (outside scroll, always visible) ── */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>Scarcity Map</Text>
          <Text style={styles.headerSub}>Bengaluru · Live</Text>
        </View>
        <View style={styles.headerRight}>
          <Animated.View style={[styles.liveDot, { opacity: liveFlashAnim }]}>
            <View style={[styles.liveDotCore, { backgroundColor: socketConnected ? '#10B981' : '#6B7280' }]} />
          </Animated.View>
          <Text style={[styles.liveLabel, { color: socketConnected ? '#10B981' : '#6B7280' }]}>
            {socketConnected ? 'LIVE' : 'OFFLINE'}
          </Text>
        </View>
      </View>

      {/* ── Everything below scrolls together ── */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              await fetchDarkstores(true)
              if (userLocation) await fetchNearbyStores(userLocation.latitude, userLocation.longitude)
              fetchWeather()
            }}
            tintColor="#10B981"
          />
        }
      >
        <WeatherSurgeBanner weather={weather} />

        {/* Summary bar */}
        <View style={styles.summaryBar}>
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryCount, { color: '#EF4444' }]}>{hotCount}</Text>
            <Text style={styles.summaryLabel}>🔴 Hot</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryCount, { color: '#F59E0B' }]}>{warmCount}</Text>
            <Text style={styles.summaryLabel}>🟡 Warm</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryCount, { color: '#10B981' }]}>{okCount}</Text>
            <Text style={styles.summaryLabel}>🟢 OK</Text>
          </View>
          {lastUpdated && (
            <>
              <View style={styles.summaryDivider} />
              <View style={styles.summaryItem}>
                <Text style={styles.summaryCount}>
                  {lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                </Text>
                <Text style={styles.summaryLabel}>Updated</Text>
              </View>
            </>
          )}
        </View>

        {/* Non-surge weather bar */}
        <WeatherBar weather={weather} />

        {/* ── MAP — scrolls with page, still shows ALL darkstores ── */}
        <View style={[styles.mapContainer, { height: MAP_HEIGHT }]}>
          <MapView
            ref={mapRef}
            style={StyleSheet.absoluteFill}
            provider={PROVIDER_DEFAULT}
            initialRegion={mapRegion}
            showsUserLocation={locationPermission}
            showsMyLocationButton={false}
            customMapStyle={DARK_MAP_STYLE}
            scrollEnabled={true}
            zoomEnabled={true}
            pitchEnabled={false}
            rotateEnabled={false}
          >
            {darkstores.map(store => {
              const opp = OPPORTUNITY_CONFIG[store.opportunity]
              return (
                <React.Fragment key={store.id}>
                  <Circle
                    center={{ latitude: store.latitude, longitude: store.longitude }}
                    radius={300}
                    fillColor={opp.color + '18'}
                    strokeColor={opp.color + '60'}
                    strokeWidth={1}
                  />
                  <Marker
                    coordinate={{ latitude: store.latitude, longitude: store.longitude }}
                    onPress={() => {
                      mapRef.current?.animateToRegion(
                        { latitude: store.latitude, longitude: store.longitude, latitudeDelta: 0.03, longitudeDelta: 0.03 },
                        400
                      )
                    }}
                  >
                    <View style={[styles.markerPin, { backgroundColor: opp.color, borderColor: '#0F0F0F' }]}>
                      <Text style={styles.markerText}>{store.activeRiders}</Text>
                    </View>
                    {checkedInAt === store.id && (
                      <View style={styles.markerYouBadge}>
                        <Text style={styles.markerYouText}>YOU</Text>
                      </View>
                    )}
                  </Marker>
                </React.Fragment>
              )
            })}
          </MapView>

          {/* Map legend overlay */}
          <View style={styles.mapLegend}>
            <Text style={styles.mapLegendTitle}>Riders active</Text>
            {[
              { color: '#EF4444', label: 'Scarce' },
              { color: '#F59E0B', label: 'Low' },
              { color: '#10B981', label: 'Good' },
            ].map(item => (
              <View key={item.label} style={styles.mapLegendRow}>
                <View style={[styles.mapLegendDot, { backgroundColor: item.color }]} />
                <Text style={styles.mapLegendLabel}>{item.label}</Text>
              </View>
            ))}
          </View>

          {/* Weather badge on map */}
          {weather && (
            <View style={[styles.mapWeatherBadge, weather.surgeActive && styles.mapWeatherBadgeSurge]}>
              <Text style={styles.mapWeatherBadgeText}>
                {weather.surgeActive ? '🌧️ Surge' : weather.weatherCode === 0 ? '☀️' : '⛅'}{' '}
                {Math.round(weather.temperature)}°
              </Text>
            </View>
          )}

          {/* Recenter button */}
          {userLocation && (
            <TouchableOpacity
              style={styles.recenterButton}
              onPress={() =>
                mapRef.current?.animateToRegion(
                  { ...userLocation, latitudeDelta: 0.06, longitudeDelta: 0.06 },
                  400
                )
              }
              activeOpacity={0.8}
            >
              <Text style={styles.recenterIcon}>◎</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── Platform filter tabs ── */}
        <View style={styles.filterBar}>
          {PLATFORM_FILTER_OPTIONS.map(opt => (
            <TouchableOpacity
              key={opt.key}
              style={[styles.filterTab, platformFilter === opt.key && styles.filterTabActive]}
              onPress={() => setPlatformFilter(opt.key)}
              activeOpacity={0.7}
            >
              <Text style={[styles.filterTabText, platformFilter === opt.key && styles.filterTabTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── Darkstore list — nearest 20 ── */}
        <View style={styles.listContent}>
          {nearbyLoading ? (
            <View style={styles.emptyState}>
              <ActivityIndicator size="small" color="#10B981" />
              <Text style={styles.emptySubtitle}>Finding nearest darkstores…</Text>
            </View>
          ) : filteredStores.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>🗺️</Text>
              <Text style={styles.emptyTitle}>No stores found</Text>
              <Text style={styles.emptySubtitle}>Try a different platform filter</Text>
            </View>
          ) : (
            filteredStores.map(store => (
              <DarkstoreCard
                key={store.id}
                store={store}
                isCheckedIn={checkedInAt === store.id}
                userLocation={userLocation}
                onCheckIn={handleCheckIn}
                onLeave={postLeave}
                selectedPlatform={selectedPlatform}
                onSelectPlatform={setSelectedPlatform}
                weather={weather}
              />
            ))
          )}

          {/* Footer */}
          <View style={styles.footer}>
            <Text style={styles.footerText}>
              Map data from voluntary rider check-ins · Waze model{'\n'}
              Check-ins expire after 10 min · Weather via Open-Meteo (free API)
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  )
}

// ─────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F0F0F',
  },

  loadingContainer: {
    flex: 1,
    backgroundColor: '#0F0F0F',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 8,
  },
  loadingSubtext: {
    color: '#6B7280',
    fontSize: 13,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 58,
    paddingBottom: 12,
    backgroundColor: '#0F0F0F',
  },
  headerLeft: {},
  headerTitle: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  headerSub: {
    color: '#6B7280',
    fontSize: 13,
    marginTop: 2,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveDotCore: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  liveLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },

  // Weather surge banner
  surgeBanner: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 14,
    backgroundColor: '#1A2E1A',
    borderWidth: 1,
    borderColor: '#10B98150',
    overflow: 'hidden',
  },
  surgeBannerInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
  },
  surgeLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  surgeIcon: {
    fontSize: 24,
  },
  surgeTitle: {
    color: '#10B981',
    fontSize: 13,
    fontWeight: '700',
  },
  surgeSubtitle: {
    color: '#6EE7B7',
    fontSize: 11,
    marginTop: 2,
    lineHeight: 15,
  },
  surgeTempBadge: {
    backgroundColor: '#10B98125',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#10B98140',
  },
  surgeTempText: {
    color: '#10B981',
    fontSize: 13,
    fontWeight: '800',
  },
  surgeSource: {
    color: '#374151',
    fontSize: 9,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },

  // Subtle weather bar (no surge)
  weatherBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: '#141414',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: '#1F1F1F',
  },
  weatherBarIcon: {
    fontSize: 14,
  },
  weatherBarText: {
    color: '#9CA3AF',
    fontSize: 12,
    flex: 1,
  },
  weatherBarNoSurge: {
    color: '#4B5563',
    fontSize: 11,
    fontWeight: '600',
  },

  // Scroll
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 32,
  },

  // Summary bar
  summaryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    backgroundColor: '#141414',
    marginHorizontal: 16,
    borderRadius: 12,
    paddingVertical: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1F1F1F',
  },
  summaryItem: {
    alignItems: 'center',
    flex: 1,
  },
  summaryCount: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  summaryLabel: {
    color: '#6B7280',
    fontSize: 11,
    marginTop: 2,
  },
  summaryDivider: {
    width: 1,
    height: 28,
    backgroundColor: '#1F1F1F',
  },

  // Map — now inside ScrollView, scrolls with page
  mapContainer: {
    marginHorizontal: 0,
    overflow: 'hidden',
    marginBottom: 0,
  },
  markerPin: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
  },
  markerText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },
  markerYouBadge: {
    position: 'absolute',
    top: -8,
    backgroundColor: '#10B981',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    alignSelf: 'center',
  },
  markerYouText: {
    color: '#fff',
    fontSize: 8,
    fontWeight: '800',
  },
  mapLegend: {
    position: 'absolute',
    top: 10,
    left: 10,
    backgroundColor: '#0F0F0FE0',
    borderRadius: 10,
    padding: 8,
    borderWidth: 1,
    borderColor: '#1F1F1F',
    gap: 4,
  },
  mapLegendTitle: {
    color: '#9CA3AF',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  mapLegendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  mapLegendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  mapLegendLabel: {
    color: '#9CA3AF',
    fontSize: 10,
  },
  mapWeatherBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    backgroundColor: '#0F0F0FE0',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#1F1F1F',
  },
  mapWeatherBadgeSurge: {
    backgroundColor: '#1A2E1AE0',
    borderColor: '#10B98150',
  },
  mapWeatherBadgeText: {
    color: '#9CA3AF',
    fontSize: 12,
    fontWeight: '700',
  },
  recenterButton: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#374151',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recenterIcon: {
    color: '#10B981',
    fontSize: 20,
  },

  // Filter bar
  filterBar: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  filterTab: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: '#141414',
    borderWidth: 1,
    borderColor: '#1F1F1F',
  },
  filterTabActive: {
    backgroundColor: '#10B98118',
    borderColor: '#10B98160',
  },
  filterTabText: {
    color: '#6B7280',
    fontSize: 12,
    fontWeight: '600',
  },
  filterTabTextActive: {
    color: '#10B981',
  },

  // List — now a plain View inside ScrollView (not nested ScrollView)
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
    gap: 12,
    flexDirection: 'column',
  },

  // Card
  card: {
    backgroundColor: '#141414',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1F1F1F',
    marginBottom: 12,
  },
  cardCheckedIn: {
    borderColor: '#10B98150',
    backgroundColor: '#0D2B1F',
  },
  cardSurgePill: {
    backgroundColor: '#10B98118',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignSelf: 'flex-start',
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#10B98140',
  },
  cardSurgePillText: {
    color: '#10B981',
    fontSize: 11,
    fontWeight: '700',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  cardTitleGroup: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    flex: 1,
    marginRight: 8,
  },
  platformDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 4,
  },
  cardName: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 20,
  },
  cardArea: {
    color: '#6B7280',
    fontSize: 12,
    marginTop: 2,
  },
  oppBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
  },
  oppBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  cardStats: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    backgroundColor: '#0F0F0F',
    borderRadius: 10,
    padding: 10,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
  },
  statLabel: {
    color: '#6B7280',
    fontSize: 10,
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    height: 30,
    backgroundColor: '#1F1F1F',
  },
  scarcityBarBg: {
    height: 4,
    backgroundColor: '#1F1F1F',
    borderRadius: 2,
    marginBottom: 6,
    overflow: 'hidden',
  },
  scarcityBarFill: {
    height: 4,
    borderRadius: 2,
  },
  scarcityBarLabel: {
    color: '#6B7280',
    fontSize: 11,
    marginBottom: 12,
  },
  platformSelector: {
    marginBottom: 10,
  },
  platformSelectorLabel: {
    color: '#9CA3AF',
    fontSize: 11,
    marginBottom: 6,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  platformPills: {
    flexDirection: 'row',
    gap: 6,
  },
  platformPill: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    backgroundColor: '#0F0F0F',
  },
  platformPillText: {
    color: '#6B7280',
    fontSize: 11,
    fontWeight: '600',
  },
  checkInButton: {
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
  },
  checkInButtonText: {
    fontSize: 14,
    fontWeight: '700',
  },
  checkedInRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  checkedInBadge: {
    flex: 1,
    backgroundColor: '#10B98118',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#10B98140',
  },
  checkedInBadgeText: {
    color: '#10B981',
    fontSize: 13,
    fontWeight: '700',
  },
  leaveButton: {
    backgroundColor: '#EF444415',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#EF444440',
  },
  leaveButtonText: {
    color: '#EF4444',
    fontSize: 13,
    fontWeight: '700',
  },

  // Privacy modal
  privacyOverlay: {
    flex: 1,
    backgroundColor: '#000000CC',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 24,
    paddingHorizontal: 16,
  },
  privacyCard: {
    backgroundColor: '#141414',
    borderRadius: 20,
    padding: 24,
    width: '100%',
    borderWidth: 1,
    borderColor: '#1F1F1F',
  },
  privacyIcon: {
    fontSize: 36,
    marginBottom: 12,
    textAlign: 'center',
  },
  privacyTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 6,
  },
  privacySubtitle: {
    color: '#9CA3AF',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 20,
  },
  privacyRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
    alignItems: 'flex-start',
  },
  privacyCheck: {
    color: '#10B981',
    fontSize: 16,
    fontWeight: '800',
    marginTop: 1,
  },
  privacyRowText: {
    color: '#D1D5DB',
    fontSize: 14,
    flex: 1,
    lineHeight: 20,
  },
  privacyButton: {
    backgroundColor: '#10B981',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 12,
  },
  privacyButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
  privacyFairwork: {
    color: '#4B5563',
    fontSize: 11,
    textAlign: 'center',
  },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingVertical: 48,
    gap: 8,
  },
  emptyIcon: {
    fontSize: 40,
  },
  emptyTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  emptySubtitle: {
    color: '#6B7280',
    fontSize: 13,
  },

  // Footer
  footer: {
    paddingTop: 8,
    paddingBottom: 4,
    alignItems: 'center',
  },
  footerText: {
    color: '#374151',
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 17,
  },
})

// ─────────────────────────────────────────────
// DARK MAP STYLE
// ─────────────────────────────────────────────

const DARK_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#1a1a1a' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#6B7280' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0f0f0f' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2d2d2d' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#333333' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3d3d3d' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#1f1f1f' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0d1117' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#2d2d2d' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#9CA3AF' }] },
]

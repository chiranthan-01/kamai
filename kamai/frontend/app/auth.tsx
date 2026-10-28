import { useState, useRef } from 'react'
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Animated,
} from 'react-native'
import { useRouter } from 'expo-router'
import { supabase } from '../lib/supabase'

const CITIES = [
  { key: 'bengaluru', label: 'Bengaluru' },
  { key: 'delhi', label: 'Delhi' },
  { key: 'chennai', label: 'Chennai' },
  { key: 'kochi', label: 'Kochi' },
  { key: 'thiruvananthapuram', label: 'Thiruvananthapuram' },
]

export default function AuthScreen() {
  const router = useRouter()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [city, setCity] = useState('bengaluru')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  const shakeAnim = useRef(new Animated.Value(0)).current

  function shake() {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 6, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -6, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start()
  }

  function validate() {
    if (!identifier.trim()) {
      setError('Enter your email address')
      return false
    }
    if (!/^\S+@\S+\.\S+$/.test(identifier.trim())) {
      setError('Enter a valid email address')
      return false
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters')
      return false
    }
    return true
  }

  async function handleSubmit() {
    setError('')
    setNotice('')
    if (!validate()) { shake(); return }

    setLoading(true)
    try {
      if (mode === 'signup') {
        await handleSignup()
      } else {
        await handleLogin()
      }
    } catch (e: any) {
      setError(e.message || 'Something went wrong. Try again.')
      shake()
    } finally {
      setLoading(false)
    }
  }

  async function handleSignup() {
    const { data, error: signupError } = await supabase.auth.signUp({
      email: identifier.trim().toLowerCase(),
      password,
      options: {
        data: {
          city_code: city,
          preferred_language: 'en',
        },
      },
    })

    if (signupError) throw signupError

    if (data.session) {
      router.replace('/onboarding')
      return
    }

    setMode('login')
    setPassword('')
    setNotice('Account created. Check your email to confirm it, then log in.')
  }

  async function handleLogin() {
    const { data, error: loginError } = await supabase.auth.signInWithPassword({
      email: identifier.trim().toLowerCase(),
      password,
    })

    if (loginError) throw loginError

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('onboarding_completed_at')
      .eq('user_id', data.user.id)
      .single()

    if (profileError) throw profileError

    router.replace(profile.onboarding_completed_at ? '/(tabs)' : '/onboarding')
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Logo area */}
        <View style={styles.logoArea}>
          <Text style={styles.logoEmoji}>₹</Text>
          <Text style={styles.logoTitle}>Kamai</Text>
          <Text style={styles.logoTagline}>Har order ka hisaab</Text>
        </View>

        {/* Mode toggle */}
        <View style={styles.modeToggle}>
          <TouchableOpacity
            style={[styles.modeTab, mode === 'login' && styles.modeTabActive]}
            onPress={() => { setMode('login'); setError(''); setNotice('') }}
            activeOpacity={0.7}
          >
            <Text style={[styles.modeTabText, mode === 'login' && styles.modeTabTextActive]}>
              Log in
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeTab, mode === 'signup' && styles.modeTabActive]}
            onPress={() => { setMode('signup'); setError(''); setNotice('') }}
            activeOpacity={0.7}
          >
            <Text style={[styles.modeTabText, mode === 'signup' && styles.modeTabTextActive]}>
              Sign up
            </Text>
          </TouchableOpacity>
        </View>

        {/* Form */}
        <Animated.View style={[styles.form, { transform: [{ translateX: shakeAnim }] }]}>

          {/* Email */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Email address</Text>
            <TextInput
              style={styles.input}
              placeholder="you@email.com"
              placeholderTextColor="#4B5563"
              value={identifier}
              onChangeText={setIdentifier}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          {/* Password */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Password</Text>
            <View style={styles.passwordRow}>
              <TextInput
                style={[styles.input, styles.passwordInput]}
                placeholder="Min 6 characters"
                placeholderTextColor="#4B5563"
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
              />
              <TouchableOpacity
                style={styles.showPasswordBtn}
                onPress={() => setShowPassword(p => !p)}
                activeOpacity={0.7}
              >
                <Text style={styles.showPasswordText}>{showPassword ? 'Hide' : 'Show'}</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* City — only on signup */}
          {mode === 'signup' && (
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Your city</Text>
              <View style={styles.cityGrid}>
                {CITIES.map(c => (
                  <TouchableOpacity
                    key={c.key}
                    style={[styles.cityPill, city === c.key && styles.cityPillActive]}
                    onPress={() => setCity(c.key)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.cityPillText, city === c.key && styles.cityPillTextActive]}>
                      {c.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {/* Error */}
          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>⚠️ {error}</Text>
            </View>
          ) : null}

          {notice ? (
            <View style={styles.noticeBox}>
              <Text style={styles.noticeText}>✓ {notice}</Text>
            </View>
          ) : null}

          {/* Submit */}
          <TouchableOpacity
            style={[styles.submitBtn, loading && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            activeOpacity={0.85}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.submitBtnText}>
                {mode === 'login' ? 'Log in →' : 'Create account →'}
              </Text>
            )}
          </TouchableOpacity>

        </Animated.View>

        {/* Footer */}
        <View style={styles.footerArea}>
          <Text style={styles.footerText}>
            Kamai never shares your data with any platform.{'\n'}
            Your earnings stay on your device.
          </Text>
          <Text style={styles.footerSource}>
            Built for gig workers · Fairwork India 2024
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F0F0F',
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 80,
    paddingBottom: 40,
  },

  // Logo
  logoArea: {
    alignItems: 'center',
    marginBottom: 40,
  },
  logoEmoji: {
    fontSize: 48,
    color: '#10B981',
    fontWeight: '800',
    marginBottom: 8,
  },
  logoTitle: {
    color: '#fff',
    fontSize: 36,
    fontWeight: '800',
    letterSpacing: -1,
  },
  logoTagline: {
    color: '#6B7280',
    fontSize: 14,
    marginTop: 4,
    letterSpacing: 0.3,
  },

  // Mode toggle
  modeToggle: {
    flexDirection: 'row',
    backgroundColor: '#141414',
    borderRadius: 12,
    padding: 4,
    marginBottom: 28,
    borderWidth: 1,
    borderColor: '#1F1F1F',
  },
  modeTab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 9,
    alignItems: 'center',
  },
  modeTabActive: {
    backgroundColor: '#10B981',
  },
  modeTabText: {
    color: '#6B7280',
    fontSize: 14,
    fontWeight: '600',
  },
  modeTabTextActive: {
    color: '#fff',
    fontWeight: '700',
  },

  // Form
  form: {
    gap: 20,
  },
  inputGroup: {
    gap: 8,
  },
  inputLabel: {
    color: '#9CA3AF',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: '#141414',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2D2D2D',
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: '#fff',
    fontSize: 15,
  },
  passwordRow: {
    position: 'relative',
  },
  passwordInput: {
    paddingRight: 64,
  },
  showPasswordBtn: {
    position: 'absolute',
    right: 16,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  showPasswordText: {
    color: '#10B981',
    fontSize: 13,
    fontWeight: '600',
  },

  // City picker
  cityGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  cityPill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#141414',
    borderWidth: 1,
    borderColor: '#2D2D2D',
  },
  cityPillActive: {
    backgroundColor: '#10B98120',
    borderColor: '#10B981',
  },
  cityPillText: {
    color: '#6B7280',
    fontSize: 13,
    fontWeight: '600',
  },
  cityPillTextActive: {
    color: '#10B981',
  },

  // Error
  errorBox: {
    backgroundColor: '#3B0F0F',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#EF444440',
  },
  errorText: {
    color: '#EF4444',
    fontSize: 13,
    lineHeight: 18,
  },
  noticeBox: {
    backgroundColor: '#0B2E23',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#10B98140',
  },
  noticeText: {
    color: '#34D399',
    fontSize: 13,
    lineHeight: 18,
  },

  // Submit
  submitBtn: {
    backgroundColor: '#10B981',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  submitBtnDisabled: {
    opacity: 0.6,
  },
  submitBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },

  // Footer
  footerArea: {
    marginTop: 40,
    alignItems: 'center',
    gap: 8,
  },
  footerText: {
    color: '#4B5563',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
  footerSource: {
    color: '#374151',
    fontSize: 11,
  },
})

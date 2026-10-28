import { useState, useRef } from 'react'
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  ScrollView,
  Animated,
  ActivityIndicator,
} from 'react-native'
import { useRouter } from 'expo-router'
import { supabase } from '../lib/supabase'

const { width } = Dimensions.get('window')

const SLIDES = [
  {
    emoji: '₹',
    emojiColor: '#10B981',
    title: 'Har order ka hisaab',
    subtitle:
      'Kamai shows you exactly what you actually take home after every platform deduction — commission, GST, TDS, app fee.',
    tag: 'Verified · Fairwork India 2024',
  },
  {
    emoji: '📍',
    emojiColor: '#F59E0B',
    title: 'Go where the orders are',
    subtitle:
      'The Scarcity Map shows which darkstores near you have fewer riders than orders right now. Less competition = more earnings.',
    tag: 'Waze model · Real rider check-ins',
  },
  {
    emoji: '🌧️',
    emojiColor: '#60A5FA',
    title: 'Rain = more money',
    subtitle:
      'When it rains in Bengaluru, orders spike and platforms pay surge bonuses. Kamai alerts you the moment surge goes live.',
    tag: 'Zepto +₹15–25 · Blinkit +₹10–20 per order',
  },
  {
    emoji: '🔒',
    emojiColor: '#A78BFA',
    title: 'Your data stays yours',
    subtitle:
      'Earnings are calculated on your device. We never share anything with Zepto, Blinkit, or Instamart. Ever.',
    tag: '₹99/year Pro · No data selling',
  },
]

export default function OnboardingScreen() {
  const router = useRouter()
  const [currentSlide, setCurrentSlide] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const scrollRef = useRef<ScrollView>(null)
  const fadeAnim = useRef(new Animated.Value(1)).current

  function goToSlide(index: number) {
    Animated.sequence([
      Animated.timing(fadeAnim, { toValue: 0, duration: 120, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
    ]).start()
    setCurrentSlide(index)
    scrollRef.current?.scrollTo({ x: index * width, animated: true })
  }

  function handleNext() {
    if (currentSlide < SLIDES.length - 1) {
      goToSlide(currentSlide + 1)
    } else {
      handleDone()
    }
  }

  async function handleDone() {
    if (saving) return

    setSaving(true)
    setError('')

    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError) throw userError
      if (!user) throw new Error('Your session has expired. Please log in again.')

      const { error: updateError } = await supabase
        .from('profiles')
        .update({ onboarding_completed_at: new Date().toISOString() })
        .eq('user_id', user.id)

      if (updateError) throw updateError

      router.replace('/(tabs)')
    } catch (e: any) {
      setError(e.message || 'Could not finish setup. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const slide = SLIDES[currentSlide]

  return (
    <View style={styles.container}>
      {/* Skip button */}
      <TouchableOpacity style={styles.skipBtn} onPress={handleDone} activeOpacity={0.7} disabled={saving}>
        <Text style={styles.skipText}>Skip</Text>
      </TouchableOpacity>

      {/* Slide content */}
      <Animated.View style={[styles.slideContent, { opacity: fadeAnim }]}>
        <View style={[styles.emojiCircle, { borderColor: slide.emojiColor + '40', backgroundColor: slide.emojiColor + '15' }]}>
          <Text style={[styles.slideEmoji, { color: slide.emojiColor }]}>{slide.emoji}</Text>
        </View>

        <Text style={styles.slideTitle}>{slide.title}</Text>
        <Text style={styles.slideSubtitle}>{slide.subtitle}</Text>

        <View style={[styles.tagPill, { borderColor: slide.emojiColor + '40', backgroundColor: slide.emojiColor + '10' }]}>
          <Text style={[styles.tagText, { color: slide.emojiColor }]}>{slide.tag}</Text>
        </View>
      </Animated.View>

      {/* Dot indicators */}
      <View style={styles.dots}>
        {SLIDES.map((_, i) => (
          <TouchableOpacity key={i} onPress={() => goToSlide(i)} activeOpacity={0.7}>
            <View
              style={[
                styles.dot,
                i === currentSlide && styles.dotActive,
                i === currentSlide && { backgroundColor: slide.emojiColor },
              ]}
            />
          </TouchableOpacity>
        ))}
      </View>

      {/* Next / Done button */}
      <TouchableOpacity
        style={[styles.nextBtn, { backgroundColor: slide.emojiColor }, saving && styles.nextBtnDisabled]}
        onPress={handleNext}
        activeOpacity={0.85}
        disabled={saving}
      >
        {saving ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <Text style={styles.nextBtnText}>
            {currentSlide === SLIDES.length - 1 ? 'Start earning smarter →' : 'Next →'}
          </Text>
        )}
      </TouchableOpacity>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <Text style={styles.slideCounter}>
        {currentSlide + 1} of {SLIDES.length}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F0F0F',
    paddingHorizontal: 28,
    paddingTop: 70,
    paddingBottom: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },

  skipBtn: {
    position: 'absolute',
    top: 60,
    right: 24,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: '#141414',
    borderWidth: 1,
    borderColor: '#2D2D2D',
  },
  skipText: {
    color: '#6B7280',
    fontSize: 13,
    fontWeight: '600',
  },

  slideContent: {
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  emojiCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
  },
  slideEmoji: {
    fontSize: 44,
    fontWeight: '800',
  },
  slideTitle: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: -0.5,
    marginBottom: 16,
    lineHeight: 34,
  },
  slideSubtitle: {
    color: '#9CA3AF',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 24,
  },
  tagPill: {
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  tagText: {
    fontSize: 12,
    fontWeight: '700',
  },

  // Dots
  dots: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 48,
    marginBottom: 28,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#2D2D2D',
  },
  dotActive: {
    width: 24,
    borderRadius: 4,
  },

  // Button
  nextBtn: {
    width: '100%',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    marginBottom: 16,
  },
  nextBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  nextBtnDisabled: {
    opacity: 0.6,
  },
  errorText: {
    color: '#EF4444',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 12,
  },
  slideCounter: {
    color: '#374151',
    fontSize: 12,
  },
})

import { useEffect } from 'react'
import { View, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'
import { supabase } from '../lib/supabase'

export default function Index() {
  const router = useRouter()

  useEffect(() => {
    checkAuth()
  }, [])

  async function checkAuth() {
    try {
      const { data: { session }, error: sessionError } = await supabase.auth.getSession()
      if (sessionError) throw sessionError

      if (!session) {
        router.replace('/auth')
        return
      }

      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('onboarding_completed_at')
        .eq('user_id', session.user.id)
        .single()

      if (profileError) throw profileError

      router.replace(profile.onboarding_completed_at ? '/(tabs)' : '/onboarding')
    } catch {
      router.replace('/auth')
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#0F0F0F', alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="large" color="#10B981" />
    </View>
  )
}

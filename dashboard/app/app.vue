<script setup lang="ts">
const colorMode = useColorMode()
colorMode.preference = 'dark'

// Hide chat on login page
const route = useRoute()
const showChat = computed(() => route.path !== '/login')

// Auth - check status on mount
const { checkAuth } = useAuth()
onMounted(() => {
  checkAuth()
  // Ensure page starts at top
  window.scrollTo(0, 0)
})

// Reset scroll position on route change to prevent whitespace glitches
watch(() => route.path, () => {
  window.scrollTo(0, 0)
  document.body.scrollTop = 0
  document.documentElement.scrollTop = 0
})

// Chat state - persists across navigation
const chatOpen = ref(false)
const { messages, isLoading, isConnected, error, sendMessage, retryMessage, clearError } = useChatSession()
const { reconnect } = useWebSocket()
const toast = useToast()

const chatInterfaceRef = ref<{ focusInput: () => void } | null>(null)

function toggleChat() {
  chatOpen.value = !chatOpen.value
}

// Focus chat input when modal opens
watch(chatOpen, (isOpen) => {
  if (isOpen) {
    nextTick(() => chatInterfaceRef.value?.focusInput())
  }
})

function closeChat() {
  chatOpen.value = false
}

function handleSendMessage(content: string, image?: string) {
  sendMessage(content, image)
}

function handleRetry(messageId?: string) {
  retryMessage(messageId)
}

function handleReconnect() {
  reconnect()
  toast.add({
    title: 'Reconnecting...',
    description: 'Attempting to reconnect to the server',
    icon: 'i-heroicons-arrow-path',
    color: 'primary',
    timeout: 3000
  })
}

// Show toast on connection status changes
watch(isConnected, (connected, wasConnected) => {
  if (connected && !wasConnected) {
    toast.add({
      title: 'Connected',
      description: 'Successfully connected to SwarmOps',
      icon: 'i-heroicons-check-circle',
      color: 'success',
      timeout: 3000
    })
  } else if (!connected && wasConnected) {
    toast.add({
      title: 'Disconnected',
      description: 'Lost connection to server. Will retry automatically.',
      icon: 'i-heroicons-exclamation-triangle',
      color: 'warning',
      timeout: 5000
    })
  }
})

// Show toast on chat errors
watch(error, (newError) => {
  if (newError) {
    toast.add({
      title: 'Message failed',
      description: newError,
      icon: 'i-heroicons-x-circle',
      color: 'error',
      timeout: 5000
    })
  }
})
</script>

<template>
  <UApp>
    <NuxtRouteAnnouncer />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
    <UToaster />

    <!-- Chat components at app level for persistence (hidden on login) -->
    <template v-if="showChat">
      <FloatingChatButton :open="chatOpen" @toggle="toggleChat" />
      <ChatModal 
        :open="chatOpen" 
        :connected="isConnected"
        @close="closeChat"
        @reconnect="handleReconnect"
      >
        <ChatInterface
          ref="chatInterfaceRef"
          :messages="messages"
          :is-typing="isLoading"
          :is-connected="isConnected"
          :error="error"
          :disabled="isLoading || !isConnected"
          @send="handleSendMessage"
          @retry="handleRetry"
          @clear-error="clearError"
        />
      </ChatModal>
    </template>
  </UApp>
</template>

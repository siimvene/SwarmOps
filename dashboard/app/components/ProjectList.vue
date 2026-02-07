<script setup lang="ts">
import type { ProjectStatus } from '~/types/project'

const route = useRoute()
const { projects, pending, error, refresh } = useProjects({
  refreshInterval: 10000,
})

const currentProject = computed(() => {
  const name = route.params.name
  return typeof name === 'string' ? name : undefined
})

function isSelected(projectName: string): boolean {
  return currentProject.value === projectName
}

function getStatusIcon(status: ProjectStatus): string {
  switch (status) {
    case 'running': return 'i-heroicons-play-circle'
    case 'completed': return 'i-heroicons-check-circle'
    case 'error': return 'i-heroicons-exclamation-circle'
    case 'paused': return 'i-heroicons-pause-circle'
    default: return 'i-heroicons-folder'
  }
}

function getStatusColor(status: ProjectStatus): string {
  switch (status) {
    case 'running': return 'var(--swarm-accent)'
    case 'completed': return 'var(--swarm-success)'
    case 'error': return 'var(--swarm-error)'
    case 'paused': return 'var(--swarm-warning)'
    default: return 'var(--swarm-text-muted)'
  }
}
</script>

<template>
  <div>
    <!-- New Project Button -->
    <NuxtLink 
      to="/projects/new"
      class="new-project-btn"
    >
      <UIcon name="i-heroicons-plus" class="w-4 h-4" />
      <span>New Project</span>
    </NuxtLink>

    <!-- Loading -->
    <div v-if="pending && !projects?.length" class="px-3 py-2">
      <div v-for="i in 3" :key="i" class="flex items-center gap-3 p-2 animate-pulse">
        <div class="skeleton-icon"></div>
        <div class="skeleton-text"></div>
      </div>
    </div>

    <!-- Error - compact inline style -->
    <button 
      v-else-if="error" 
      class="error-retry-btn"
      @click="() => refresh()"
    >
      <UIcon name="i-heroicons-exclamation-triangle" class="w-4 h-4" />
      <span>Retry loading projects</span>
    </button>

    <!-- Empty -->
    <div v-else-if="!projects?.length" class="empty-state">
      <UIcon name="i-heroicons-folder-open" class="empty-icon" />
      <p class="empty-text">No projects</p>
    </div>

    <!-- Project list - simple items like Kleidia nav -->
    <NuxtLink
      v-for="project in projects"
      :key="project.name"
      :to="`/project/${project.name}`"
      class="project-item"
      :class="{ active: isSelected(project.name) }"
    >
      <UIcon 
        :name="getStatusIcon(project.status)" 
        class="project-icon"
        :style="{ color: isSelected(project.name) ? 'var(--swarm-accent)' : getStatusColor(project.status) }"
      />
      <span class="project-name">{{ project.name }}</span>
      <span 
        v-if="project.status === 'running'" 
        class="status-dot"
      ></span>
    </NuxtLink>
  </div>
</template>

<style scoped>
.new-project-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  margin: 2px 8px;
  border-radius: 6px;
  background: transparent;
  color: var(--swarm-text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  text-decoration: none;
}

.new-project-btn:hover {
  background: var(--swarm-bg-hover);
  color: var(--swarm-text-primary);
}

.project-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  margin: 2px 8px;
  border-radius: 6px;
  color: var(--swarm-text-secondary);
  font-size: 13px;
  font-weight: 500;
  transition: all 0.15s;
  cursor: pointer;
  text-decoration: none;
}

.project-item:hover {
  background: var(--swarm-bg-hover);
  color: var(--swarm-text-primary);
}

.project-item.active {
  background: var(--swarm-accent-bg);
  color: var(--swarm-accent);
}

.project-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.project-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--swarm-accent);
  flex-shrink: 0;
  animation: blink 1s infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.error-retry-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  margin: 2px 8px;
  border-radius: 6px;
  background: transparent;
  color: var(--swarm-text-muted);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.error-retry-btn:hover {
  background: var(--swarm-bg-hover);
  color: var(--swarm-text-secondary);
}

.skeleton-icon {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  background: var(--swarm-bg-hover);
}

.skeleton-text {
  height: 16px;
  width: 96px;
  border-radius: 4px;
  background: var(--swarm-bg-hover);
}

.empty-state {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  margin: 2px 8px;
  color: var(--swarm-text-muted);
  font-size: 13px;
}

.empty-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.empty-text {
  font-size: 13px;
}
</style>
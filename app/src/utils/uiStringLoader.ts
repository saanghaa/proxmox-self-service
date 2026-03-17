/**
 * UI String Loader Utility
 *
 * 모든 UI 텍스트(placeholders, labels, messages 등)를 로드하고 관리합니다.
 * Single Source of Truth: ui-strings.json + SystemConfig DB overrides
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

// Default paths
// After build: __dirname = /app/dist/utils, defaults is at /app/dist/defaults
const UI_STRINGS_PATH = join(__dirname, '../defaults/ui-strings.json');

/**
 * UI Strings structure matching ui-strings.json
 */
export interface UIStrings {
  common: {
    buttons: Record<string, string>;
    messages: Record<string, string>;
  };
  login: {
    title: string;
    subtitle: string;
    emailPlaceholder: string;
    passwordPlaceholder: string;
    loginButton: string;
    forgotPasswordLink: string;
    noAccountText: string;
    registerLink: string;
  };
  register: {
    title: string;
    subtitle: string;
    emailPlaceholder: string;
    passwordPlaceholder: string;
    confirmPasswordPlaceholder: string;
    registerButton: string;
    hasAccountText: string;
    loginLink: string;
  };
  forgotPassword: {
    title: string;
    subtitle: string;
    emailPlaceholder: string;
    sendButton: string;
    backToLogin: string;
  };
  otp: {
    title: string;
    subtitle: string;
    tokenPlaceholder: string;
    submitButton: string;
  };
  dashboard: {
    title: string;
    myGroups: string;
    myVms: string;
    vmRequest: string;
    jobsAndVms: string;
    searchPlaceholder: string;
    noVms: string;
    noRequests: string;
  };
  forms: {
    addVm: {
      title: string;
      description: string;
      vmidLabel: string;
      vmidPlaceholder: string;
      hostnameLabel: string;
      hostnamePlaceholder: string;
      ipLabel: string;
      ipPlaceholder: string;
      nodeLabel: string;
      nodePlaceholder: string;
      cpuLabel: string;
      cpuPlaceholder: string;
      memoryLabel: string;
      memoryPlaceholder: string;
      diskLabel: string;
      diskPlaceholder: string;
      groupLabel: string;
      groupPlaceholder: string;
      sshKeyTitle: string;
      sshKeyDescription: string;
      privateKeyLabel: string;
      publicKeyLabel: string;
      publicKeyHint: string;
      cancelButton: string;
      submitButton: string;
    };
    vmRequest: {
      title: string;
      description: string;
      instanceTypeLabel: string;
      vmCountLabel: string;
      purposeLabel: string;
      purposePlaceholder: string;
      groupLabel: string;
      submitButton: string;
      cancelButton: string;
    };
  };
  admin: {
    title: string;
    tabs: Record<string, string>;
    users: {
      title: string;
      addButton: string;
      exportButton: string;
      emailColumn: string;
      roleColumn: string;
      groupsColumn: string;
      actionsColumn: string;
    };
    uiSettings: {
      title: string;
      description: string;
      saveButton: string;
      resetButton: string;
      searchPlaceholder: string;
      categoryLabel: string;
      keyLabel: string;
      valueLabel: string;
      successMessage: string;
      errorMessage: string;
      resetConfirm: string;
    };
  };
}

/**
 * Cache for loaded strings
 */
let cachedDefaultStrings: UIStrings | null = null;
let cachedMergedStrings: UIStrings | null = null;
let lastDbFetchTime: number = 0;
const CACHE_TTL = 60000; // 1 minute cache for DB overrides

/**
 * Load default UI strings from JSON file
 */
export function loadDefaultUIStrings(): UIStrings {
  if (cachedDefaultStrings) {
    return cachedDefaultStrings;
  }

  try {
    const jsonContent = readFileSync(UI_STRINGS_PATH, 'utf-8');
    cachedDefaultStrings = JSON.parse(jsonContent) as UIStrings;
    console.log('[UIStrings] Loaded default strings from JSON file');
    return cachedDefaultStrings;
  } catch (error) {
    console.error('[UIStrings] Failed to load default strings from JSON:', error);

    // Minimal emergency fallback
    console.warn('[UIStrings] Using minimal emergency fallback');
    cachedDefaultStrings = {
      common: {
        buttons: {
          login: 'Login',
          logout: 'Logout',
          cancel: 'Cancel',
          submit: 'Submit',
          save: 'Save',
          delete: 'Delete',
        },
        messages: {
          success: 'Operation completed successfully',
          error: 'An error occurred',
          loading: 'Loading...',
        },
      },
      login: {
        title: 'Proxmox Horizon',
        subtitle: 'Self-Service Portal',
        emailPlaceholder: 'Email',
        passwordPlaceholder: 'Password',
        loginButton: 'Login',
        forgotPasswordLink: 'Forgot password?',
        noAccountText: 'No account?',
        registerLink: 'Sign up',
      },
      register: {
        title: 'Register',
        subtitle: 'Create your account',
        emailPlaceholder: 'Email',
        passwordPlaceholder: 'Password',
        confirmPasswordPlaceholder: 'Confirm Password',
        registerButton: 'Register',
        hasAccountText: 'Already have an account?',
        loginLink: 'Login',
      },
      forgotPassword: {
        title: 'Forgot Password',
        subtitle: 'Reset your password',
        emailPlaceholder: 'Email',
        sendButton: 'Send',
        backToLogin: 'Back to login',
      },
      otp: {
        title: '2FA',
        subtitle: 'Enter OTP code',
        tokenPlaceholder: '000000',
        submitButton: 'Submit',
      },
      dashboard: {
        title: 'Dashboard',
        myGroups: 'My Groups',
        myVms: 'My VMs',
        vmRequest: 'VM Request',
        jobsAndVms: 'Jobs & VMs',
        searchPlaceholder: 'Search...',
        noVms: 'No VMs',
        noRequests: 'No requests',
      },
      forms: {
        addVm: {
          title: 'Add Existing VM',
          description: 'Register an existing VM',
          vmidLabel: 'VMID',
          vmidPlaceholder: 'e.g., 100',
          hostnameLabel: 'Hostname',
          hostnamePlaceholder: 'e.g., web-server-01',
          ipLabel: 'IP Address',
          ipPlaceholder: 'e.g., 10.10.20.100',
          nodeLabel: 'Node',
          nodePlaceholder: 'e.g., pve01',
          cpuLabel: 'CPU (vCPU)',
          cpuPlaceholder: 'e.g., 4',
          memoryLabel: 'Memory (GB)',
          memoryPlaceholder: 'e.g., 8',
          diskLabel: 'Disk (GB)',
          diskPlaceholder: 'e.g., 100',
          groupLabel: 'Group',
          groupPlaceholder: '-- Select Group --',
          sshKeyTitle: 'SSH Key Upload',
          sshKeyDescription: 'Upload SSH key pair',
          privateKeyLabel: 'Private Key',
          publicKeyLabel: 'Public Key',
          publicKeyHint: 'Optional',
          cancelButton: 'Cancel',
          submitButton: 'Add VM',
        },
        vmRequest: {
          title: 'VM Request',
          description: 'Request new VM',
          instanceTypeLabel: 'Instance Type',
          vmCountLabel: 'VM Count',
          purposeLabel: 'Purpose',
          purposePlaceholder: 'e.g., Web server',
          groupLabel: 'Group',
          submitButton: 'Submit',
          cancelButton: 'Cancel',
        },
      },
      admin: {
        title: 'Admin Panel',
        tabs: {
          vmRequests: 'VM Requests',
          deletedVms: 'Deleted VMs',
          users: 'Users',
          groups: 'Groups',
          notifications: 'Notifications',
          passwordPolicy: 'Password Policy',
          auditLogs: 'Audit Logs',
          menuSettings: 'Menu Settings',
          uiSettings: 'UI Settings',
        },
        users: {
          title: 'User Management',
          addButton: 'Add User',
          exportButton: 'Export CSV',
          emailColumn: 'Email',
          roleColumn: 'Role',
          groupsColumn: 'Groups',
          actionsColumn: 'Actions',
        },
        uiSettings: {
          title: 'UI Settings',
          description: 'Customize UI text',
          saveButton: 'Save',
          resetButton: 'Reset',
          searchPlaceholder: 'Search...',
          categoryLabel: 'Category',
          keyLabel: 'Key',
          valueLabel: 'Value',
          successMessage: 'Saved successfully',
          errorMessage: 'Save failed',
          resetConfirm: 'Reset all settings?',
        },
      },
    } as UIStrings;
    return cachedDefaultStrings;
  }
}

/**
 * Load UI string overrides from database (SystemConfig)
 */
async function loadUIStringOverrides(prisma: PrismaClient): Promise<Partial<UIStrings> | null> {
  try {
    const config = await prisma.systemConfig.findUnique({
      where: { key: 'ui_strings' },
    });

    if (!config) {
      return null;
    }

    const overrides = JSON.parse(config.value) as Partial<UIStrings>;
    console.log('[UIStrings] Loaded overrides from database');
    return overrides;
  } catch (error) {
    console.error('[UIStrings] Failed to load overrides from database:', error);
    return null;
  }
}

/**
 * Deep merge two objects (overrides take precedence)
 */
function deepMerge<T>(target: T, source: Partial<T> | null): T {
  if (!source) {
    return target;
  }

  const result = { ...target };

  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (sourceValue !== undefined) {
      if (
        typeof sourceValue === 'object' &&
        sourceValue !== null &&
        !Array.isArray(sourceValue) &&
        typeof targetValue === 'object' &&
        targetValue !== null &&
        !Array.isArray(targetValue)
      ) {
        // Recursive merge for nested objects
        result[key] = deepMerge(targetValue, sourceValue as any);
      } else {
        // Direct override for primitives and arrays
        result[key] = sourceValue as any;
      }
    }
  }

  return result;
}

/**
 * Get UI strings with database overrides merged
 *
 * @param prisma - Prisma client instance
 * @param forceRefresh - Force refresh from database (bypass cache)
 * @returns Merged UI strings (defaults + overrides)
 */
export async function getUIStrings(
  prisma: PrismaClient,
  forceRefresh: boolean = false
): Promise<UIStrings> {
  const now = Date.now();

  // Return cached if still valid
  if (
    !forceRefresh &&
    cachedMergedStrings &&
    now - lastDbFetchTime < CACHE_TTL
  ) {
    return cachedMergedStrings;
  }

  // Load defaults
  const defaults = loadDefaultUIStrings();

  // Load overrides from database
  const overrides = await loadUIStringOverrides(prisma);

  // Merge
  cachedMergedStrings = deepMerge(defaults, overrides);
  lastDbFetchTime = now;

  return cachedMergedStrings;
}

/**
 * Get default UI strings (without database overrides)
 * Useful for reset operations
 */
export function getDefaultUIStrings(): UIStrings {
  return loadDefaultUIStrings();
}

/**
 * Save UI string overrides to database
 *
 * @param prisma - Prisma client instance
 * @param overrides - Partial UI strings to override defaults
 */
export async function saveUIStringOverrides(
  prisma: PrismaClient,
  overrides: Partial<UIStrings>
): Promise<void> {
  try {
    await prisma.systemConfig.upsert({
      where: { key: 'ui_strings' },
      update: {
        value: JSON.stringify(overrides, null, 2),
      },
      create: {
        key: 'ui_strings',
        value: JSON.stringify(overrides, null, 2),
      },
    });

    console.log('[UIStrings] Saved overrides to database');

    // Clear cache to force reload
    clearCache();
  } catch (error) {
    console.error('[UIStrings] Failed to save overrides to database:', error);
    throw new Error('Failed to save UI string overrides');
  }
}

/**
 * Reset UI strings to defaults (remove all overrides)
 *
 * @param prisma - Prisma client instance
 */
export async function resetUIStrings(prisma: PrismaClient): Promise<void> {
  try {
    await prisma.systemConfig.delete({
      where: { key: 'ui_strings' },
    });

    console.log('[UIStrings] Reset to defaults (removed overrides)');

    // Clear cache
    clearCache();
  } catch (error) {
    // If record doesn't exist, that's fine
    if ((error as any).code !== 'P2025') {
      console.error('[UIStrings] Failed to reset UI strings:', error);
      throw new Error('Failed to reset UI strings');
    }

    console.log('[UIStrings] No overrides to reset');
    clearCache();
  }
}

/**
 * Clear cache (useful for testing and hot-reloading)
 */
export function clearCache(): void {
  cachedMergedStrings = null;
  lastDbFetchTime = 0;
  console.log('[UIStrings] Cache cleared');
}

/**
 * Get a specific nested value from UI strings by path
 * Example: getUIString(strings, 'login.emailPlaceholder') => 'Email'
 *
 * @param strings - UI strings object
 * @param path - Dot-separated path (e.g., 'login.emailPlaceholder')
 * @returns The value at the path, or the path itself if not found
 */
export function getUIString(strings: UIStrings, path: string): string {
  const parts = path.split('.');
  let value: any = strings;

  for (const part of parts) {
    if (value && typeof value === 'object' && part in value) {
      value = value[part];
    } else {
      return path; // Return path if not found (fallback)
    }
  }

  return typeof value === 'string' ? value : path;
}

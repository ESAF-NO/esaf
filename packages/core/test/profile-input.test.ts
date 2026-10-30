import { describe, expect, it } from 'vitest'
import { profileInput } from '../src/profiles.ts'

const profile = {
  fullName: 'Thomas Schuller',
  city: '',
  studyBackground: '',
  esCompany: '',
  expertise: [],
  industries: [],
  experience: [],
  linkedinUrl: '',
  contactEmail: '',
  contactEmailVisible: false,
  phone: '',
  phoneVisible: false,
}

describe('profile biography validation', () => {
  it('preserves imported biographies when onboarding saves the profile', () => {
    const bio = 'a'.repeat(1093)
    expect(profileInput.parse({ ...profile, bio }).bio).toBe(bio)
  })
  it('uses the same 10,000-character limit as the dataset import', () => {
    expect(profileInput.safeParse({ ...profile, bio: 'a'.repeat(10_000) }).success).toBe(true)
    expect(profileInput.safeParse({ ...profile, bio: 'a'.repeat(10_001) }).success).toBe(false)
  })
})

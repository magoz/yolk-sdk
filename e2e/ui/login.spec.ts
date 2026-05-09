import { test, expect } from '@playwright/test'

test('login page loads correctly', async ({ page }) => {
  await page.goto('/login')

  // Verify the login form is visible
  await expect(page.getByPlaceholder('Email')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible()
})

test('home page loads correctly', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Reusable agent stack' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
})

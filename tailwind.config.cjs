/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#101216', 900: '#14161a', 800: '#1a1d23', 700: '#21252d',
          600: '#2b303a', 500: '#3a4150', 300: '#8b93a3', 200: '#b4bac6', 100: '#e7eaf0'
        },
        accent: { DEFAULT: '#2f7bff', hover: '#4f8fff', soft: 'rgba(47,123,255,0.16)' }
      },
      fontFamily: { sans: ['"Segoe UI Variable Text"', '"Segoe UI"', 'Inter', 'system-ui', 'sans-serif'] }
    }
  },
  plugins: []
}

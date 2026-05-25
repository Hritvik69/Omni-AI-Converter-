import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        ink: "#070A12",
        panel: "#0E1424",
        line: "rgba(148,163,184,0.16)",
        neon: {
          cyan: "#39F5E8",
          violet: "#9B5CFF",
          lime: "#B6FF68",
          rose: "#FF4D8D"
        }
      },
      boxShadow: {
        glow: "0 0 44px rgba(57,245,232,0.18)",
        violet: "0 0 40px rgba(155,92,255,0.18)"
      }
    }
  },
  plugins: []
};

export default config;

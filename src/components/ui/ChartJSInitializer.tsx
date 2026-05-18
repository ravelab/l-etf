"use client";

import { useEffect } from "react";
import { Chart as ChartJS, CategoryScale, LinearScale, LogarithmicScale, PointElement, LineElement, TimeScale, Tooltip, Legend } from "chart.js";
import "chartjs-adapter-date-fns";

// Track if ChartJS has been initialized
let isInitialized = false;

export function ChartJSInitializer() {
  useEffect(() => {
    if (isInitialized) return;
    
    // Register all required components
    ChartJS.register(
      CategoryScale,
      LinearScale,
      LogarithmicScale,
      PointElement,
      LineElement,
      TimeScale,
      Tooltip,
      Legend
    );
    
    isInitialized = true;
  }, []);
  
  return null;
}

export function ensureChartJSRegistered() {
  if (isInitialized) return true;
  
  ChartJS.register(
    CategoryScale,
    LinearScale,
    LogarithmicScale,
    PointElement,
    LineElement,
    TimeScale,
    Tooltip,
    Legend
  );
  
  isInitialized = true;
  return true;
}

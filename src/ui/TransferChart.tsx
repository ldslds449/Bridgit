import { Chart as ChartJS, LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip } from "chart.js";
import { Line } from "react-chartjs-2";
import type { ChartData } from "chart.js";

ChartJS.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip);

export default function TransferChart({ data }: { data: ChartData<"line", number[], string> }) {
  const colors = ["#288e70", "#86aabf"];
  return <Line aria-label="每秒 SSH 傳送與接收流量" role="img" data={{ ...data, datasets: data.datasets.map((dataset, i) => ({
    ...dataset, borderColor: colors[i], backgroundColor: `${colors[i]}10`, borderWidth: 1.6, pointRadius: 0, pointHitRadius: 8, tension: .35, fill: true,
  })) }} options={{
    animation: false, responsive: true, maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    scales: {
      x: { display: false },
      y: { beginAtZero: true, suggestedMax: 1024, border: { display: false }, grid: { color: "#829a8b18" }, ticks: {
        maxTicksLimit: 4, color: "#8a9c90", font: { size: 9 }, padding: 8,
        callback: value => Number(value) >= 1048576 ? `${(Number(value) / 1048576).toFixed(1)} MB` : `${Math.round(Number(value) / 1024)} KB`,
      } },
    },
    plugins: { legend: { display: false }, tooltip: { displayColors: false, backgroundColor: "#20382c", padding: 10, callbacks: {
      label: item => `${item.datasetIndex === 0 ? "傳送" : "接收"}：${((item.parsed.y ?? 0) / 1024).toFixed(1)} KB/s`,
    } } },
  }} />;
}

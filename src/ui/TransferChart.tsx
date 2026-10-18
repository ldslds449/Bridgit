import { Chart as ChartJS, LineController, LineElement, PointElement, LinearScale, Title, CategoryScale, Legend } from 'chart.js';
import { Line } from 'react-chartjs-2';
import type { ChartData } from "chart.js";

ChartJS.register(LineController, LineElement, PointElement, LinearScale, Title, CategoryScale, Legend);

export default function TransferChart({ data }: { data: ChartData<"line", number[], string> }) {
  return (<Line data={data} options={{
        animation: false,
        scales: {
          y: {
            title: {
              display: true,
              text: "Bytes"
            },
            suggestedMax: 1000000,
          }
        },
        responsive: true,
        plugins: {
          legend: {
            position: 'top' as const,
          },
        },
      }} />
  );
}

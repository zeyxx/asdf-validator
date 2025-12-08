/**
 * ASDF Validator Dashboard - Frontend
 */

// State
let totalFees = 0;
let feeCount = 0;
let orphanFees = 0;
let orphanFeeCount = 0;
let chartData = [];
const MAX_CHART_POINTS = 60;

// DOM elements
const wsStatus = document.getElementById('ws-status');
const wsText = document.getElementById('ws-text');
const creatorAddress = document.getElementById('creator-address');
const totalFeesEl = document.getElementById('total-fees');
const bcBalanceEl = document.getElementById('bc-balance');
const ammBalanceEl = document.getElementById('amm-balance');
const feeCountEl = document.getElementById('fee-count');
const orphanFeesEl = document.getElementById('orphan-fees');
const orphanCountEl = document.getElementById('orphan-count');
const feesTbody = document.getElementById('fees-tbody');
const tokensTbody = document.getElementById('tokens-tbody');
const lastUpdateEl = document.getElementById('last-update');

// Chart setup
const ctx = document.getElementById('fees-chart').getContext('2d');
const chart = new Chart(ctx, {
  type: 'line',
  data: {
    labels: [],
    datasets: [{
      label: 'Cumulative Fees (SOL)',
      data: [],
      borderColor: '#ff6b35',
      backgroundColor: 'rgba(255, 107, 53, 0.1)',
      fill: true,
      tension: 0.4,
      pointRadius: 0,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: {
        display: true,
        grid: {
          color: 'rgba(255, 255, 255, 0.1)'
        },
        ticks: {
          color: '#888',
          maxTicksLimit: 10
        }
      },
      y: {
        display: true,
        grid: {
          color: 'rgba(255, 255, 255, 0.1)'
        },
        ticks: {
          color: '#888'
        }
      }
    },
    plugins: {
      legend: {
        display: false
      }
    },
    animation: {
      duration: 0
    }
  }
});

// Hourly chart setup
const hourlyCtx = document.getElementById('hourly-chart').getContext('2d');
const hourlyChart = new Chart(hourlyCtx, {
  type: 'bar',
  data: {
    labels: [],
    datasets: [{
      label: 'Fees per Hour (SOL)',
      data: [],
      backgroundColor: 'rgba(147, 112, 219, 0.6)',
      borderColor: 'rgba(147, 112, 219, 1)',
      borderWidth: 1,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: {
        display: true,
        grid: {
          color: 'rgba(255, 255, 255, 0.1)'
        },
        ticks: {
          color: '#888',
          maxRotation: 45,
          minRotation: 45
        }
      },
      y: {
        display: true,
        beginAtZero: true,
        grid: {
          color: 'rgba(255, 255, 255, 0.1)'
        },
        ticks: {
          color: '#888'
        }
      }
    },
    plugins: {
      legend: {
        display: false
      }
    },
    animation: {
      duration: 0
    }
  }
});

// Update hourly chart
function updateHourlyChart(feesPerHour) {
  if (!feesPerHour || feesPerHour.length === 0) return;

  hourlyChart.data.labels = feesPerHour.map(b => b.hour);
  hourlyChart.data.datasets[0].data = feesPerHour.map(b => b.amount);
  hourlyChart.update('none');
}

// Format time
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString();
}

// Format short time for chart
function formatShortTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Update chart
function updateChart(fees) {
  const now = Date.now();
  chartData.push({ time: now, fees: parseFloat(fees) });

  // Keep only last MAX_CHART_POINTS
  if (chartData.length > MAX_CHART_POINTS) {
    chartData.shift();
  }

  chart.data.labels = chartData.map(d => formatShortTime(d.time));
  chart.data.datasets[0].data = chartData.map(d => d.fees);
  chart.update('none');
}

// Update tokens table
function updateTokensTable(tokens) {
  if (!tokens || tokens.length === 0) return;

  tokensTbody.innerHTML = '';
  tokens.forEach(token => {
    const row = document.createElement('tr');
    row.className = 'token-row';
    const shortMint = token.mint.substring(0, 4) + '...' + token.mint.substring(token.mint.length - 4);
    const status = token.migrated ? 'AMM' : 'BC';
    const statusClass = token.migrated ? 'migrated' : 'active';
    const displayName = token.name || token.symbol || '-';
    row.innerHTML = `
      <td class="token-symbol">${token.symbol}</td>
      <td class="token-name">${displayName}</td>
      <td class="token-mint" title="${token.mint}">${shortMint}</td>
      <td class="token-fees">${token.totalFees} SOL</td>
      <td class="token-count">${token.feeCount}</td>
      <td class="token-status ${statusClass}">${status}</td>
    `;
    tokensTbody.appendChild(row);
  });
}

// Add fee to table
function addFeeToTable(fee) {
  // Remove empty row if present
  const emptyRow = feesTbody.querySelector('.empty-row');
  if (emptyRow) {
    emptyRow.remove();
  }

  const row = document.createElement('tr');
  row.className = 'fee-row new';
  row.innerHTML = `
    <td>${formatTime(fee.timestamp)}</td>
    <td class="amount">+${fee.amount} SOL</td>
    <td class="vault ${fee.vault.toLowerCase()}">${fee.vault}</td>
    <td class="slot">${fee.slot}</td>
  `;

  feesTbody.insertBefore(row, feesTbody.firstChild);

  // Remove animation class after animation completes
  setTimeout(() => row.classList.remove('new'), 500);

  // Keep only last 20 rows
  while (feesTbody.children.length > 20) {
    feesTbody.removeChild(feesTbody.lastChild);
  }
}

// Update connection status
function setConnected(connected) {
  if (connected) {
    wsStatus.className = 'status-indicator connected';
    wsText.textContent = 'Connected';
  } else {
    wsStatus.className = 'status-indicator disconnected';
    wsText.textContent = 'Disconnected';
  }
}

// Update last update time
function updateLastUpdate() {
  lastUpdateEl.textContent = formatTime(Date.now());
}

// Handle WebSocket messages
function handleMessage(event) {
  const message = JSON.parse(event.data);

  switch (message.type) {
    case 'state':
      // Initial state
      const state = message.data;
      creatorAddress.textContent = state.creator;
      totalFeesEl.textContent = state.totalFees;
      bcBalanceEl.textContent = state.bcBalance;
      ammBalanceEl.textContent = state.ammBalance;
      feeCountEl.textContent = state.feeCount;
      totalFees = parseFloat(state.totalFees);
      feeCount = state.feeCount;
      setConnected(state.connected);

      // Update orphan fees
      if (state.orphanFees !== undefined) {
        orphanFeesEl.textContent = state.orphanFees;
        orphanCountEl.textContent = state.orphanFeeCount;
        orphanFees = parseFloat(state.orphanFees);
        orphanFeeCount = state.orphanFeeCount;
      }

      // Add recent fees to table
      if (state.recentFees && state.recentFees.length > 0) {
        feesTbody.innerHTML = '';
        state.recentFees.slice(0, 20).reverse().forEach(fee => addFeeToTable(fee));
      }

      // Update tokens table
      if (state.tokens) {
        updateTokensTable(state.tokens);
      }

      // Initialize chart
      updateChart(state.totalFees);

      // Initialize hourly chart
      if (state.feesPerHour) {
        updateHourlyChart(state.feesPerHour);
      }
      break;

    case 'fee':
      // New fee detected
      const fee = message.data;
      totalFeesEl.textContent = fee.totalFees;
      feeCountEl.textContent = fee.feeCount;
      totalFees = parseFloat(fee.totalFees);
      feeCount = fee.feeCount;

      // Update orphan fees
      if (fee.orphanFees !== undefined) {
        orphanFeesEl.textContent = fee.orphanFees;
        orphanCountEl.textContent = fee.orphanFeeCount;
        orphanFees = parseFloat(fee.orphanFees);
        orphanFeeCount = fee.orphanFeeCount;
      }

      addFeeToTable(fee);
      updateChart(fee.totalFees);
      updateLastUpdate();

      // Update tokens table
      if (fee.tokens) {
        updateTokensTable(fee.tokens);
      }

      // Update hourly chart
      if (fee.feesPerHour) {
        updateHourlyChart(fee.feesPerHour);
      }

      // Flash the appropriate card
      const totalCard = document.querySelector('.stat-card.total-fees');
      totalCard.classList.add('flash');
      setTimeout(() => totalCard.classList.remove('flash'), 300);

      // Flash orphan card if it's an orphan fee
      if (fee.isOrphan) {
        const orphanCard = document.querySelector('.stat-card.orphan-fees');
        orphanCard.classList.add('flash');
        setTimeout(() => orphanCard.classList.remove('flash'), 300);
      }
      break;

    case 'balance':
      // Balance update
      const balance = message.data;
      bcBalanceEl.textContent = balance.bcBalance;
      ammBalanceEl.textContent = balance.ammBalance;
      updateLastUpdate();
      break;

    case 'status':
      // Connection status
      setConnected(message.data.connected);
      break;
  }
}

// Connect WebSocket
function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${window.location.host}`);

  ws.onopen = () => {
    console.log('WebSocket connected');
    setConnected(true);
  };

  ws.onmessage = handleMessage;

  ws.onclose = () => {
    console.log('WebSocket disconnected');
    setConnected(false);
    // Reconnect after 3 seconds
    setTimeout(connect, 3000);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
}

// Start
connect();

// Update time every second
setInterval(() => {
  if (lastUpdateEl.textContent !== '-') {
    // Already have an update, don't change
  }
}, 1000);

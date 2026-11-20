const scores = [
  { name: 'Ada', points: 12 },
  { name: 'Lin', points: 19 },
]

function renderScores(list) {
  const ul = document.getElementById('scores')
  for (const s of list) {
    const li = document.createElement('li')
    li.textContent = `${s.name}: ${s.points}`
    ul.appendChild(li)
  }
}

renderScores(scores)

var downwave = document.getElementById('downout');

// 添加动画结束事件监听器
downwave.addEventListener('animationend', function() {
  // 在动画结束后执行你的操作，比如改变元素属性
  downwave.style.display = 'none'
  var video1 = document.getElementById("video1");
  var video2 = document.getElementById("video2");
  video1.play();
  video1.addEventListener('ended', function() {
    // 在视频播放结束时执行你的操作
    // alert('视频播放结束！');
    video1.style.display = 'none'
    video2.play();
  });
});
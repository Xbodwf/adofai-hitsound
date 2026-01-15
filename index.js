import * as fs from 'fs/promises';
import wav from 'node-wav';
import { OfflineAudioContext } from 'node-web-audio-api';

class AudioSplicer {
  constructor() {
    this.audioData = null;
    this.timePoints = [];
    this.sampleRate = 44100;
    this.outputPath = null;
    this.totalDuration = null;
  }

  async loadAudio(filePath) {
    const audioBuffer = await fs.readFile(filePath);
    
    // 使用node-web-audio-api的解析器
    const audioContext = new OfflineAudioContext(2, 1, this.sampleRate);
    
    this.audioData = await new Promise((resolve, reject) => {
      audioContext.decodeAudioData(audioBuffer.buffer, resolve, reject);
    });
    
    this.sampleRate = this.audioData.sampleRate;
    this.audioDuration = this.audioData.duration;
    console.log(`已加载音频: ${filePath}, 时长: ${this.audioDuration.toFixed(2)}s, 采样率: ${this.sampleRate}Hz`);
  }

  loadTimePoints(filePath) {
    return fs.readFile(filePath, 'utf8')
      .then(data => {
        this.timePoints = JSON.parse(data);
        console.log(`已加载时间点: ${this.timePoints.length} 个`);
      });
  }

  setOutputPath(path) {
    this.outputPath = path;
  }

  setTotalDuration(duration) {
    this.totalDuration = duration;
  }

  async concatenate() {
    if (!this.audioData) throw new Error('请先加载音频');
    if (!this.timePoints.length) throw new Error('请先加载时间点');
    if (!this.outputPath) throw new Error('请设置输出路径');
    
    // 计算总帧数
    if (!this.totalDuration) {
      const maxTime = this.timePoints.reduce((max, t) => Math.max(max, t), 0);
      this.totalDuration = maxTime + this.audioDuration;
      console.log(`自动计算总时长: ${this.totalDuration.toFixed(2)}s`);
    }
    
    const totalFrames = Math.floor(this.totalDuration * this.sampleRate);
    const numChannels = this.audioData.numberOfChannels;
    
    console.log('开始高质量处理音频...');
    console.time('处理完成');
    
    // 创建离线音频上下文进行高质量处理
    const offlineContext = new OfflineAudioContext(
      numChannels,
      totalFrames,
      this.sampleRate
    );
    
    // 分批次处理时间点，避免内存溢出
    const batchSize = 500;
    const totalBatches = Math.ceil(this.timePoints.length / batchSize);
    
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const startIdx = batchIndex * batchSize;
      const endIdx = Math.min(startIdx + batchSize, this.timePoints.length);
      
      // 处理当前批次的时间点
      for (let i = startIdx; i < endIdx; i++) {
        const timePoint = this.timePoints[i];
        
        // 创建缓冲源节点
        const source = offlineContext.createBufferSource();
        source.buffer = this.audioData;
        
        // 创建压缩器进行动态范围控制（提升音质）
        const compressor = offlineContext.createDynamicsCompressor();
        compressor.threshold.setValueAtTime(-24, offlineContext.currentTime);
        compressor.knee.setValueAtTime(30, offlineContext.currentTime);
        compressor.ratio.setValueAtTime(12, offlineContext.currentTime);
        compressor.attack.setValueAtTime(0, offlineContext.currentTime);
        compressor.release.setValueAtTime(0.25, offlineContext.currentTime);
        
        // 连接节点：源 -> 压缩器 -> 输出
        source.connect(compressor);
        compressor.connect(offlineContext.destination);
        
        // 在指定时间点播放
        source.start(timePoint);
      }
      
      // 更新进度
      const processed = endIdx;
      const percent = (processed / this.timePoints.length * 100).toFixed(1);
      process.stdout.clearLine();
      process.stdout.cursorTo(0);
      process.stdout.write(`处理进度: ${processed}/${this.timePoints.length} (${percent}%)`);
      
      // 每批处理后等待一小段时间，避免阻塞
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    // 完成进度显示
    process.stdout.write('\n');
    console.log('渲染音频中... 这可能需要一些时间');
    
    // 渲染音频
    const renderedBuffer = await offlineContext.startRendering();
    
    // 规范化音频数据
    const normalizedBuffer = this.normalizeAudioBuffer(renderedBuffer);
    
    // 写入输出文件
    console.log('写入输出文件...');
    const channelData = Array.from(
      { length: numChannels },
      (_, ch) => normalizedBuffer.getChannelData(ch)
    );
    
    const encodedWav = wav.encode(channelData, {
      sampleRate: this.sampleRate,
      float: true,
      bitDepth: 32
    });
    
    await fs.writeFile(this.outputPath, encodedWav);
    console.timeEnd('处理完成');
    console.log(`处理完成: ${this.outputPath}`);
    return this.outputPath;
  }

  // 规范化音频缓冲区，防止削波并优化动态范围
  normalizeAudioBuffer(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    let maxSample = 0;
    
    // 找到最大样本值
    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const absSample = Math.abs(channelData[i]);
        if (absSample > maxSample) {
          maxSample = absSample;
        }
      }
    }
    
    // 如果需要，创建新的规范化缓冲区
    if (maxSample > 0.95) { // 设置阈值，保留一些动态范围
      const scale = 0.95 / maxSample;
      const context = new OfflineAudioContext(numChannels, length, audioBuffer.sampleRate);
      const newBuffer = context.createBuffer(numChannels, length, audioBuffer.sampleRate);
      
      for (let ch = 0; ch < numChannels; ch++) {
        const sourceData = audioBuffer.getChannelData(ch);
        const targetData = newBuffer.getChannelData(ch);
        
        for (let i = 0; i < length; i++) {
          targetData[i] = sourceData[i] * scale;
        }
      }
      
      console.log(`音频已规范化，缩放因子: ${scale.toFixed(6)}`);
      return newBuffer;
    }
    
    return audioBuffer;
  }
}

// 命令行接口
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 3) {
    console.error('使用方法: node audio-splicer.js <输入音频路径> <时间点文件路径> <输出音频路径> [总时长(秒)]');
    console.error('示例: node audio-splicer.js input.wav timepoints.json output.wav 60');
    process.exit(1);
  }
  
  const [inputAudioPath, timePointsPath, outputPath, totalDurationArg] = args;
  const totalDuration = totalDurationArg ? parseFloat(totalDurationArg) : null;
  
  try {
    const splicer = new AudioSplicer();
    await splicer.loadAudio(inputAudioPath);
    await splicer.loadTimePoints(timePointsPath);
    splicer.setOutputPath(outputPath);
    
    if (totalDuration) {
      splicer.setTotalDuration(totalDuration);
    }
    
    await splicer.concatenate();
  } catch (error) {
    console.error('处理音频时发生错误:', error.message);
    console.error(error.stack); // 输出完整的错误堆栈
    process.exit(1);
  }
}

// 执行主函数
main();    

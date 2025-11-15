// audio-concat.js
import fs from 'fs/promises';
import wav from 'node-wav';
import { AudioContext } from 'node-web-audio-api';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class AudioConcatenator {
  constructor() {
    this.timePoints = [];
    this.audioData = null;
    this.sampleRate = 44100;
    this.totalDuration = null;
    this.audioDuration = 0;
    this.outputPath = path.join(__dirname, 'output.wav');
    this.audioContext = new AudioContext();
    this.bitDepth = 16;
  }

  async loadTimePoints(jsonPath) {
    try {
      const data = await fs.readFile(jsonPath, 'utf8');
      this.timePoints = JSON.parse(data);
      
      if (!Array.isArray(this.timePoints) || this.timePoints.length === 0) {
        throw new Error('时间点数据必须是一个非空数组');
      }
      
      // 过滤无效时间点
      this.timePoints = this.timePoints
        .map(t => parseFloat(t))
        .filter(t => !isNaN(t) && t >= 0);
      
      console.log(`加载了 ${this.timePoints.length} 个时间点`);
    } catch (error) {
      console.error('加载时间点失败:', error);
      throw error;
    }
  }

  async loadAudio(audioPath) {
    try {
      const buffer = await fs.readFile(audioPath);
      const result = wav.decode(buffer);
      
      if (!result.channelData || result.channelData.length === 0) {
        throw new Error('无法解析音频数据');
      }
      
      // 创建 AudioBuffer 对象
      this.audioData = this.audioContext.createBuffer(
        result.channelData.length,
        result.channelData[0].length,
        result.sampleRate
      );
      
      // 填充音频数据
      for (let ch = 0; ch < result.channelData.length; ch++) {
        this.audioData.copyToChannel(result.channelData[ch], ch);
      }
      
      this.sampleRate = result.sampleRate;
      this.audioDuration = result.channelData[0].length / result.sampleRate;
      
      console.log(`加载音频: ${this.audioDuration.toFixed(2)}s, ${this.sampleRate}Hz`);
    } catch (error) {
      console.error('加载音频失败:', error);
      throw error;
    }
  }

  setOutputOptions(options = {}) {
    if (options.outputPath) this.outputPath = options.outputPath;
    if (options.sampleRate) this.sampleRate = options.sampleRate;
    if (options.totalDuration) this.totalDuration = options.totalDuration;
    if (options.bitDepth) this.bitDepth = options.bitDepth;
  }

  async concatenate() {
    if (!this.audioData) throw new Error('请先加载音频');
    if (!this.timePoints.length) throw new Error('请先加载时间点');
    
    // 计算总帧数
    if (!this.totalDuration) {
      const maxTime = this.timePoints.reduce((max, t) => Math.max(max, t), 0);
      this.totalDuration = maxTime + this.audioDuration;
      console.log(`自动计算总时长: ${this.totalDuration.toFixed(2)}s`);
    }
    
    const totalFrames = Math.floor(this.totalDuration * this.sampleRate);
    const numChannels = this.audioData.numberOfChannels;
    
    // 创建静音输出缓冲区
    const outputBuffer = this.audioContext.createBuffer(
      numChannels,
      totalFrames,
      this.sampleRate
    );
    
    // 预先获取所有通道数据（减少函数调用开销）
    const sourceChannelData = Array.from(
      { length: numChannels },
      (_, ch) => this.audioData.getChannelData(ch)
    );
    
    const targetChannelData = Array.from(
      { length: numChannels },
      (_, ch) => outputBuffer.getChannelData(ch)
    );
    
    const audioLength = this.audioData.length;
    
    console.log('开始处理音频...');
    
    // 分批处理时间点（每批1000个，避免阻塞事件循环）
    const batchSize = 1000;
    const totalBatches = Math.ceil(this.timePoints.length / batchSize);
    
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const startIdx = batchIndex * batchSize;
      const endIdx = Math.min(startIdx + batchSize, this.timePoints.length);
      
      // 使用 Promise 和 setImmediate 非阻塞处理
      await new Promise(resolve => {
        setImmediate(() => {
          // 处理当前批次的时间点
          for (let i = startIdx; i < endIdx; i++) {
            const timePoint = this.timePoints[i];
            const startFrame = Math.floor(timePoint * this.sampleRate);
            
            if (startFrame >= totalFrames) continue;
            
            // 处理所有通道
            for (let ch = 0; ch < numChannels; ch++) {
              const sourceData = sourceChannelData[ch];
              const targetData = targetChannelData[ch];
              
              // 计算复制长度（避免超出目标缓冲区）
              const copyLength = Math.min(audioLength, totalFrames - startFrame);
              
              // 直接混合音频（无削波处理）
              for (let j = 0; j < copyLength; j++) {
                targetData[startFrame + j] += sourceData[j];
              }
            }
          }
          
          // 更新进度（使用 process.stdout 覆盖同一行）
          const processed = endIdx;
          const percent = (processed / this.timePoints.length * 100).toFixed(1);
          process.stdout.clearLine();
          process.stdout.cursorTo(0);
          process.stdout.write(`处理进度: ${processed}/${this.timePoints.length} (${percent}%)`);
          
          resolve();
        });
      });
    }
    
    // 完成进度显示
    process.stdout.write('\n');
    console.log('写入输出文件...');
    
    // 写入输出文件
    const channelData = Array.from(
      { length: numChannels },
      (_, ch) => outputBuffer.getChannelData(ch)
    );
    
    const encodedWav = wav.encode(channelData, {
      sampleRate: this.sampleRate,
      float: false,
      bitDepth: this.bitDepth
    });
    
    await fs.writeFile(this.outputPath, encodedWav);
    console.log(`处理完成: ${this.outputPath}`);
    return this.outputPath;
  }
}

export default AudioConcatenator;
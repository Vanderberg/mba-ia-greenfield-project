import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export type VideoStatus = 'draft' | 'processing' | 'ready' | 'failed';

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  channel_id: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title: string | null;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  @Index()
  status: VideoStatus;

  @Column({ type: 'varchar', length: 512, unique: true })
  storage_key: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'int', nullable: true })
  duration_seconds: number | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
